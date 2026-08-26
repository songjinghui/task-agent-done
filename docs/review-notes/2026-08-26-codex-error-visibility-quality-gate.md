---
feature_ids:
  - taskmux-codex-error-visibility
topics:
  - codex
  - errors
  - review
doc_kind: quality-gate
created: 2026-08-26
---

# Codex Error Visibility Quality Gate

Spec: `docs/superpowers/specs/2026-08-26-codex-turn-error-visibility-design.md`

Plan: `feature-specs/2026-08-26-codex-turn-error-visibility.md`

Original request: explain why a sent `hi` produced no data, then implement
option A while forwarding the selected Codex error for diagnosis.

Checked: 2026-08-26 08:19 CST

## Vision coverage

| # | Operator requirement | Spec coverage | Implementation |
| --- | --- | --- | --- |
| 1 | Do not leave a sent prompt looking silent | Goal, terminal states | Fixed failed/interrupted alerts |
| 2 | Forward Codex error detail for diagnosis | Error boundary | `codexErrorInfo` + `message` only |
| 3 | Keep unrelated raw/private data out | Error boundary | Exact event + negative leakage tests |
| 4 | Deliver and push, not a partial prototype | Verification | Full gate, review, remote SHA check required |

The accepted A scope is complete. Durable provider-error persistence and
automatic retry were explicitly excluded; the implementation extends rather
than requires rewriting the existing event path.

## Functional acceptance

| Requirement | Code | Test evidence |
| --- | --- | --- |
| Forward selected failed-turn fields | `src/server/codex/codex-adapter.ts` | real-shaped usage-limit unit case |
| Sanitize malformed/extra fields | `src/server/codex/codex-adapter.ts` | malformed + `additionalDetails` negative assertions |
| Live error wins | existing reducer + `Thread` projection | App test and Playwright error flow |
| Failed/interrupted fallback | `src/client/components/Thread.tsx` | parameterized App tests |
| Clear stale terminal notice | pure summary-status projection | running/completed App test |
| No automatic retry | no effects/provider calls added | implementation diff inspection |

## Gate matrix and tail scan

- No unmet acceptance criterion.
- No close-gate follow-up/deferred-tail keyword appears in the active spec,
  plan, bug report, or implementation commit messages.
- Repository does not contain `check-hotfix-pattern.mjs`,
  `check-fallback-layers.mjs`, or an architecture-ownership check script.
- Fallback-layer manual scan: one existing provider-neutral fallback plus one
  selected-field extraction; no stacked fallback chain.

## Architecture ownership

- Architecture cell: N/A — existing Codex adapter/event/client thread path.
- Map delta: none.
- Why: no new Store, Queue, Router, Adapter, lifecycle owner, or persisted
  state. The client notice is a pure projection of existing state.
- Diff mismatch scan: clean.

## Design evidence

- `find designs -name '*.pen'`: no matching design file.
- The UI change reuses the existing `.turn-error` alert style.
- Automated screenshot:
  `/private/tmp/taskmux-evidence/codex-error-visibility/failed-after-refresh.png`
- Automated browser recording:
  `/private/tmp/taskmux-evidence/codex-error-visibility/error-flow.webm`
- Screenshot inspection confirms the selected failed conversation displays
  `上一轮执行失败。` in the existing alert treatment.

## Dogfood-Your-Slice

Scope verdict: required; this changes an operator-visible browser path.

End-to-end path:

```text
browser Composer → POST /messages → ConversationService → Codex adapter →
real-shaped failed turn/completed → SSE → reducer → Thread alert → refresh →
thread/read + persisted failed summary → fixed failure alert
```

Command:

```bash
pnpm exec playwright test tests/e2e/workbench.spec.ts \
  -g "shows a Codex usage error"
```

Result: 1/1 passed. The browser saw the exact usage-limit message, did not see
`private billing detail`, and after refresh saw the fixed failed notice. No real
model turn, credits, or tools were used.

## Verification evidence

| Command | Result |
| --- | --- |
| `pnpm vitest run src/server/codex/codex-adapter.test.ts src/client/App.test.tsx` | 2 files / 70 tests passed |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 20 files / 300 tests passed |
| `pnpm build` | exit 0; Vite transformed 24 modules |
| `pnpm test:e2e` | Chromium 9/9 passed |
| `git diff --check 75e074a..HEAD` | exit 0 |

The E2E suite reported that port 24678 was already in use by the intentionally
running TaskMux development instance on 4317. Each isolated test server still
used its own ephemeral HTTP port and all nine browser tests passed.

## Artifact hygiene

- Root-level media/design artifact scan: no matches.
- `/private/tmp/taskmux-e2e-*`: no leftovers.
- No fake App Server or TaskMux process from the isolated test worktree remains.
- Screenshot/video evidence is outside the repository under `/private/tmp`.
- The worktree-local untracked `node_modules` symlink was created only to reuse
  the repository's installed dependencies; it is excluded from commits and will
  be removed with the temporary worktree after integration.
