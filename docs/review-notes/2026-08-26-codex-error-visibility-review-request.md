---
feature_ids:
  - taskmux-codex-error-visibility
topics:
  - codex
  - errors
  - review
doc_kind: review-request
created: 2026-08-26
---

# Review Request: Codex Error Visibility

Review-Target-ID: `fix-codex-error-visibility`

Branch: `fix/codex-error-visibility`

Range: `75e074a..10f08d8`

## What

- Forward only a failed Codex turn's non-blank `codexErrorInfo` and `message`
  through the existing terminal error event.
- Preserve sanitized fallbacks for missing/malformed error data and unsupported
  statuses.
- Render fixed failed/interrupted notices when the selected conversation has no
  live provider error.
- Add unit, client, and real browser E2E coverage plus a bug report and quality
  gate report.

## Why

The operator sent `hi` and saw no response. Runtime investigation proved the
prompt reached real Codex 0.147.0, no assistant item was emitted, one turn
returned `usageLimitExceeded`, and another was interrupted. TaskMux discarded
the useful failed-turn fields and rendered no fallback after live state was
lost.

Original requirement source:
`docs/bug-report/codex-silent-turn/bug-report.md`

Operator intent, condensed from the active conversation:

> Explain why `hi` receives no data. Implement option A, but forward the Codex
> error so it is easy to diagnose. Finish and push it to GitHub.

## Tradeoff

- Selected-field forwarding was chosen over forwarding the complete provider
  payload, preserving a narrow privacy boundary.
- Durable database storage was not selected; after reload the UI shows a fixed
  failed/interrupted notice rather than the former exact provider message.
- Automatic retry was rejected because it can duplicate work or consume more
  usage.
- No ACP code or in-progress ACP draft is part of this change.

## Open Questions

Technical review questions:

1. Is using non-blank `codexErrorInfo` directly as the existing event `code`
   safe for all current consumers?
2. Does the pure `ConversationSummary.status` projection avoid stale notices
   across every existing running/completed transition?
3. Is the selected error-field boundary narrow enough while still meeting the
   operator's explicit diagnostic requirement?

Value questions: none; the operator explicitly approved the boundary and the
non-persistent minimal scope.

## Architecture Ownership

- Architecture cell: N/A — existing Codex adapter → shared error event → client
  live state → Thread projection.
- Map delta: none.
- Why: no new owner, Store, Queue, Router, Adapter, persisted state, or parallel
  lifecycle object was introduced.

## Fresh-Context Findings

The optional fresh-context agent produced no findings because its own turn
failed with a Codex usage-limit error before inspection. This is not treated as
review evidence or approval. Formal review must inspect the complete diff
independently.

## Self-Check Evidence

Quality report:
`docs/review-notes/2026-08-26-codex-error-visibility-quality-gate.md`

- Focused: 2 files / 70 tests passed.
- Typecheck: exit 0.
- Unit: 20 files / 300 tests passed.
- Build: exit 0; 24 client modules transformed.
- Browser E2E: Chromium 9/9 passed.
- Diff check: exit 0.
- Root media/design artifact scans: empty.
- `.pen` scan: no matching design.
- Browser screenshot:
  `/private/tmp/taskmux-evidence/codex-error-visibility/failed-after-refresh.png`
- Browser recording:
  `/private/tmp/taskmux-evidence/codex-error-visibility/error-flow.webm`

The repeated E2E warning about WebSocket port 24678 comes from the intentionally
running TaskMux instance on 4317. E2E HTTP servers use isolated ephemeral ports.

## Next Action

Please perform a read-only independent formal review of `75e074a..10f08d8`
against the approved design and plan. Check correctness, provider-error privacy,
client state transitions, fixture realism, and test strength. Return Critical /
Important / Minor findings with file:line references and a clear
APPROVE / REQUEST CHANGES verdict covering HEAD `10f08d8`.
