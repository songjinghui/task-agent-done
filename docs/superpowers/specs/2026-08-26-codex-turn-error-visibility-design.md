---
feature_ids:
  - taskmux-codex-error-visibility
topics:
  - codex
  - errors
  - workbench
doc_kind: design
created: 2026-08-26
---

# Codex Turn Error Visibility Design

## Goal

When Codex accepts a prompt but produces no assistant text, TaskMux must explain
the terminal outcome instead of leaving the conversation looking stalled or
empty.

## Verified cause

The real Codex 0.147.0 thread accepted three `hi` prompts and produced no
assistant item. One turn completed with `usageLimitExceeded`, a zero credit
balance, and a reset-time message. A later turn remained active for about seven
minutes and was then interrupted. TaskMux currently replaces a failed Codex
turn error with `Agent turn failed.` and renders no equivalent explanation for
an interrupted turn after live state is lost.

## Error boundary

- For a failed Codex turn, TaskMux forwards only the turn error's
  `codexErrorInfo` and `message` fields to the existing terminal error event.
- `codexErrorInfo`, when present and non-blank, becomes the event `code`.
  Otherwise the existing `turn_failed` code is retained.
- `message`, when present and non-blank, is shown verbatim as text. React's
  normal text escaping remains the rendering boundary.
- No complete Codex payload, stack, command, path, request parameters, IDs, or
  other error fields cross the server/browser boundary.
- Failed turns without a usable error keep the existing provider-neutral
  fallback: `Agent turn failed.`
- Unsupported turn statuses keep their existing sanitized behavior.

This deliberately exposes the selected Codex error text for diagnosis. It does
not make the rest of the raw App Server protocol browser-visible.

## User-visible terminal states

- A live failed turn displays the forwarded Codex message in the existing
  error alert.
- If the selected conversation is `failed` and no live error is available,
  the thread displays a fixed failure notice instead of appearing empty.
- If it is `interrupted` and no live error is available, the thread displays a
  fixed interruption notice.
- A live provider message takes precedence over the fixed fallback.
- Completed and currently running conversations do not show a stale terminal
  notice.

Exact provider error text is not persisted by this minimal change. After a page
reload, TaskMux can still explain that the turn failed or was interrupted, but
it uses the fixed fallback unless the error is present in current live state.

## Non-goals

- No automatic retry, because it could duplicate work or consume more usage.
- No database migration or durable provider-error storage.
- No change to cancellation, SSE ownership, or global turn locking.
- No change to the in-progress ACP backend work.

## Verification

1. Adapter tests prove a real-shaped `usageLimitExceeded` failure forwards only
   `codexErrorInfo` and `message`.
2. Adapter tests prove missing or malformed error data uses the existing
   sanitized fallback and does not leak additional fields.
3. Client tests prove live error precedence and failed/interrupted fallback
   notices, including their removal after a new running/completed state.
4. Focused tests, full unit tests, typecheck, build, and browser E2E remain
   green.
