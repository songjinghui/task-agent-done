---
feature_ids:
  - taskmux-text-v1
topics:
  - codex
  - error-recovery
doc_kind: quality-gate
created: 2026-08-27
---

# Codex Request Recovery Quality Gate

Spec: `docs/superpowers/specs/2026-08-26-codex-request-recovery-design.md`

Plan: `feature-specs/2026-08-26-codex-request-recovery.md`

Original operator requirement: a failed previous send must not make later sends impossible; Codex errors must remain diagnosable instead of becoming a generic `internal_error`.

## Vision Coverage

| Requirement | Result | Evidence |
|---|---|---|
| Failed `turn/start` releases conversation ownership | Pass | Runtime test observes repository `failed`, then a later explicit send succeeds |
| Transiently unhealthy App Server is replaced once | Pass | Runtime tests cover one replacement, duplicate exit suppression, budget exhaustion, and stale-client isolation |
| Prompt is not automatically replayed | Pass | Runtime and browser tests assert the replacement receives nothing until the operator sends again |
| Business errors do not restart Codex | Pass | Non-recoverable JSON-RPC error stays on the current client |
| Error is useful and safe | Pass | Typed 503 carries only an allowlisted diagnostic; unknown detail, auth, env, payload, JSON-RPC `data`, paths, and stderr do not cross the boundary |
| Next explicit send works through replacement | Pass | Delayed runtime tests hold an immediate retry; Playwright retries before waiting for readiness and receives `hello world` |
| Repeated failure does not loop | Pass | Second recoverable failure degrades health and starts no third client |

## Fresh-Context Disposition

An independent scan of `bc88786` found two Important issues before formal
review. Both were reproduced with failing tests and fixed:

| Finding | Disposition | Evidence |
|---|---|---|
| Environment values, file URIs, UNC paths, and stack lines could cross `publicMessage` | Fixed in `803c275` | JSON-RPC tests cover the response path and the `CodexRequestError` constructor boundary |
| A live child whose stdin stopped accepting requests could reject with an untyped error and remain installed | Fixed in `803c275` | Real child-process fixture closes stdin while staying alive; `turn/start` now rejects with a recoverable typed event |

The same audit tightened unknown JSON-RPC internal errors to non-recoverable by
default. Only the observed child-process timeout signature is classified as a
recoverable response failure; transport timeouts, invalid responses, stopped
stdin, and exits retain their explicit transport classifications. A full E2E
rerun then exposed an exit/request ordering regression; `e7bd3da` preserves exit
supervision and adds the stable manual restart action for repeated request
failures.

Formal review round 1 found two additional Important issues and one related
Minor. `e5ef568` resolves all three with RED/GREEN coverage:

| Finding | Disposition | Evidence |
|---|---|---|
| Remaining blacklist gaps could expose authorization, cwd, prompt, or colon-form env fields | Replaced blacklist with fail-closed diagnostic allowlist | Constructor and HTTP boundary tests cover all reviewer examples; unknown detail is fixed generic text |
| Immediate explicit retry could hit the temporary unavailable adapter | Existing replaceable adapter now holds operations until replacement settles | Delayed stop and delayed start test proves retry remains pending and reaches only the replacement |
| Automatic recovery could display the manual restart action before recovery finished | Health stays `ok` during the bounded automatic replacement; degraded/manual action appears only on failure or exhausted budget | Runtime test checks in-progress and failed health; full browser crash/request recovery paths pass |

## Independent Re-review

The same independent reviewer re-read `8db693c`, reran the high-risk suites
(5 files / 177 tests), typecheck, and Chromium E2E (10/10), and confirmed both
round-1 Important findings plus the related Minor were resolved. It reported no
remaining Critical or Important finding and prepared an `APPROVED with Minor`
verdict; delivery of the final formatted message was interrupted by the
reviewer's usage limit after the evidence and conclusion had already been sent.

One non-blocking Minor remains documented: two fixed safe normalized messages
(`Codex authentication failed.` and `Codex rejected the request as invalid.`)
become the generic safe provider message if normalized a second time. This can
reduce diagnostic specificity but cannot expose private data, consume restart
budget incorrectly, replay a prompt, or prevent recovery.

## Stateful Invariants

- INV-1 through INV-8 from the plan are covered by focused runtime, service, HTTP, reducer, and E2E tests.
- Runtime provider generation remains owned by `startTaskMux`; no parallel supervisor or adapter was introduced.
- Conversation send ownership remains owned by `ConversationService`.
- Client attempt ownership remains owned by the existing conversation reducer.

## Architecture Ownership

- Architecture cell: provider runtime / conversation transport
- Map delta: none
- Why: the change extends the existing JSON-RPC client event, runtime restart budget, replaceable adapter, and send reducer.
- Diff mismatch scan: no new Store, Queue, Router, Adapter, Dispatcher, or Binding.
- Repository has no `check:architecture-ownership` script; reported as unavailable rather than inferred.

## Fallback and Tail Scan

- Repository has no `scripts/check-hotfix-pattern.mjs` or `scripts/check-fallback-layers.mjs`.
- Manual diff inspection found one explicit classification boundary: recoverable request failures restart, non-recoverable failures do not.
- No deferred/follow-up blocker was found in the active design or plan.

## UI and Design Evidence

- `designs/**/*.pen`: no matching design file.
- UI layout is unchanged; only the existing Composer alert receives the safe server message.
- Screenshot: `/private/tmp/taskmux-evidence/codex-request-recovery/request-recovery-success.png`
- Video: `/private/tmp/taskmux-evidence/codex-request-recovery/page@f4efcf0ea2f47878c7c40d95fef7a684.webm`
- Visual inspection: the failed optimistic message is absent; the explicit retry and assistant response appear exactly once; Composer is unlocked.

## Dogfood-Your-Slice

Scope verdict: required because send recovery is operator-visible.

Path: browser Composer → real TaskMux HTTP route → ConversationService → replaceable adapter → JSON-RPC fake App Server rejection → runtime replacement → explicit browser retry → SSE assistant response.

Command:

```text
pnpm exec playwright test tests/e2e/request-recovery-evidence.spec.ts
```

Result: 1 passed. The temporary evidence test was removed after capture and is not part of the repository.

Real Codex was not called during verification; the deterministic fixture reproduces the exact JSON-RPC internal-error shape without consuming quota or mutating an operator thread.

## Fresh Verification

| Command | Result |
|---|---|
| `pnpm typecheck` | Pass, both TypeScript configurations |
| `pnpm test` | Pass, 20 files / 322 tests |
| `pnpm build` | Pass, Vite 24 modules plus server TypeScript build |
| `pnpm test:e2e` | Pass, Chromium 10/10 |
| Focused runtime/client suites | Pass, 5 files / 176 tests |
| `git diff --check origin/feature/taskmux-text-v1..HEAD` | Pass |

The repository does not define `lint` or `check` scripts. Playwright reported that WebSocket port 24678 was already occupied by the intentionally running 4317 development instance; each E2E harness used isolated ephemeral HTTP state and all tests exited cleanly.

## Artifact Hygiene

- Worktree root contains no media artifact.
- Committed diff contains no root media artifact.
- Screenshot and video live under `/private/tmp/taskmux-evidence/`.
- Worktree is clean after committing this report.

## Gate Verdict

Author quality gate: pass. Formal independent review remains required before delivery.
