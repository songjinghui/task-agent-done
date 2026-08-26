---
feature_ids:
  - taskmux-codex-error-visibility
topics:
  - codex
  - errors
  - workbench
doc_kind: bug-report
created: 2026-08-26
---

# Codex Turn Appears Silent

## 1. Reporter and symptom

The operator sent `hi` in the TaskMux browser workbench and received no
assistant text or useful explanation.

## 2. Reproduction

1. Start TaskMux against the local Codex 0.147.0 App Server.
2. Create or select a conversation and send `hi`.
3. Let Codex terminate the turn with a structured failure, or interrupt a turn
   before it produces assistant text.

Expected: the workbench explains the provider failure or at least the failed /
interrupted terminal state.

Actual: failed Codex detail was replaced with `Agent turn failed.` while an
interrupted conversation could show only the user message and appear silent.

## 3. Root cause analysis

Runtime preflight identified the listener, its exact worktree, current HEAD,
real `codex app-server` child, healthy HTTP endpoint, and retained log. A
read-only `thread/read` against the real thread proved that all prompts reached
Codex and no assistant item was produced. One turn contained
`usageLimitExceeded` with zero credits; a later turn remained active and was
then interrupted.

The loss occurred at two boundaries:

- `CodexAppServerAdapter.#handleTurnCompleted` discarded `turn.error` and always
  emitted the generic failed-turn code/message.
- `Thread` rendered only a current `liveError`; after live state was absent, it
  did not project `failed` or `interrupted` from the selected conversation.

This ruled out the browser POST, HTTP availability, the 0.147 envelope format,
and conversation persistence as the cause of the missing explanation.

## 4. Fix

- Forward only non-blank `codexErrorInfo` and `message` from failed Codex turns.
- Keep sanitized fallbacks for absent/malformed data and unsupported statuses.
- Render fixed failed/interrupted notices when no live error exists.
- Give a live provider error precedence over the fixed notice.
- Do not retry automatically or persist raw provider errors.

## 5. Verification

- Adapter RED proved the real-shaped selected fields were replaced by generic
  values; GREEN verifies exact forwarding and excludes `additionalDetails`.
- Client RED proved failed/interrupted summaries had no alert; GREEN verifies
  both notices, provider-error precedence, and notice retirement on a new turn.
- Focused verification: 2 test files and 70 tests pass.
- Full typecheck, unit, build, browser E2E, diff hygiene, and independent review
  are required before delivery.
