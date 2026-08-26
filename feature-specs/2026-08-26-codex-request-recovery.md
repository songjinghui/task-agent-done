---
feature_ids:
  - taskmux-text-v1
topics:
  - codex
  - error-recovery
doc_kind: implementation-plan
created: 2026-08-26
---

# Codex Request Recovery Implementation Plan

**Feature:** TaskMux Text Workbench V1 — Codex request recovery
**Goal:** A pre-acceptance `turn/start` failure reports a safe useful error, releases ownership, replaces a transiently unhealthy Codex App Server once, and permits the next explicit send.
**Acceptance Criteria:** No automatic prompt retry; safe 503 response; transient request failure consumes one restart; business failure consumes none; stale client isolation; next explicit send succeeds after replacement; repeat failure degrades health.
**Architecture cell:** provider runtime / conversation transport
**Map delta:** none
**Map delta why:** This extends the existing Codex client, replaceable adapter, and runtime supervisor ownership boundaries without adding a new subsystem.
**Architecture:** `CodexJsonRpcClient` produces a typed safe request error with method and recovery class. `startTaskMux` observes a recoverable `turn/start` failure and reuses the existing replacement budget and generation isolation. HTTP maps the typed error to 503, while the client renders its safe message.
**Tech Stack:** TypeScript, Fastify, React, Vitest, Playwright
**前端验证:** Yes — browser E2E verifies the safe send error and successful explicit retry after provider replacement.

---

## Finish Line

The failed request returns without retaining conversation ownership; one background provider replacement completes; the next operator send reaches the replacement client; no prompt is automatically replayed. We are not building general retry middleware, durable error storage, or a new health subsystem.

## Stateful Object Census

### Runtime provider generation

Owner: `startTaskMux`.

| State | Event | Next state | Effect |
|---|---|---|---|
| current, budget=1 | recoverable `turn/start` failure | restarting, budget=0 | retire client, make proxy unavailable, start one replacement |
| restarting | replacement ready | current, awaiting completion | install replacement, health ok |
| restarting | replacement fails | degraded | stable health error, no loop |
| current, budget=0 | another recoverable failure | degraded | retire client, no restart |
| awaiting completion | owned `turn_completed` | current, budget=1 | restore budget |
| any | non-recoverable request error | unchanged | no restart |
| any | stale client error/exit | unchanged | generation guard drops it |

### Conversation send ownership

Owner: `ConversationService`.

| State | Event | Next state | Effect |
|---|---|---|---|
| idle | send | pending | set repository running and acquire global ownership |
| pending | request rejection | failed/unowned | set failed and release all ownership |
| pending | provider acceptance | running | bind turn identity |
| running | terminal | idle/failed/interrupted | release all ownership |

### Client send attempt

Owner: conversation reducer.

| State | Event | Next state | Effect |
|---|---|---|---|
| optimistic | typed HTTP rejection | tombstone | rollback unaccepted turn and show safe API message |
| optimistic | accepted evidence | accepted | preserve live turn; later HTTP loss cannot roll back |
| accepted | terminal | terminal observed | reconcile history normally |

## Invariants and Adversarial Matrix

- INV-1 request rejection releases ownership: service test sends on a second conversation immediately.
- INV-2 no automatic replay: runtime test asserts one `turn/start` call on the failed client and none on the replacement until a new explicit send.
- INV-3 one budget use: concurrent error and exit from the same retired client create one replacement.
- INV-4 business errors do not restart: typed usage/auth/invalid-input cases keep the same client.
- INV-5 stale isolation: late error, exit, and terminal event from the retired client cannot change health or current adapter.
- INV-6 safe boundary: tests assert `data`, stack, stderr, paths, params, and raw protocol are absent from HTTP/SSE/client text.
- INV-7 next send succeeds: runtime integration test sends explicitly after replacement.
- Crash window: shutdown during replacement stops both starting and retired clients and prevents late install.
- Recovery failure: replacement handshake failure degrades health and leaves proxy unavailable.
- Concurrent duplicate signal: request failure followed by exit shares one restart promise and budget debit.

## Task 1: Typed JSON-RPC Request Errors

**Files:**
- Modify: `src/server/codex/json-rpc-client.ts`
- Modify: `src/server/codex/codex-types.ts`
- Test: `src/server/codex/json-rpc-client.test.ts`

1. Add RED tests for safe message/code extraction, method attribution, recoverable child-process timeout, non-recoverable business error, and raw-field exclusion.
2. Run `pnpm vitest run src/server/codex/json-rpc-client.test.ts` and confirm behavior failures.
3. Add the smallest typed error and request-failure event implementation; keep raw `data` private.
4. Re-run the focused suite and commit.

## Task 2: Runtime Replacement on Recoverable Turn Start Failure

**Files:**
- Modify: `src/server/main.ts`
- Test: `src/server/main.test.ts`

1. Add RED tests for one replacement, no replay, next explicit send, business-error no restart, duplicate error/exit, repeated failure degradation, stale events, and shutdown during replacement.
2. Confirm focused failures with `pnpm vitest run src/server/main.test.ts`.
3. Refactor the existing exit restart path into an identity-guarded retirement/restart function and subscribe to typed request failures.
4. Re-run focused tests and commit.

## Task 3: HTTP and Composer Error Visibility

**Files:**
- Modify: `src/server/http-routes.ts`
- Modify: `src/client/conversation-store.tsx`
- Test: `src/server/http-routes.test.ts`
- Test: `src/client/App.test.tsx`

1. Add RED tests that typed Codex failures return 503 plus safe message and that Composer renders the API message without private fields.
2. Confirm focused failures.
3. Map typed provider errors explicitly and carry the safe message through `sendTransportRejected`.
4. Re-run focused tests and commit.

## Task 4: Browser Recovery Acceptance

**Files:**
- Modify: `tests/fixtures/fake-app-server.mjs`
- Modify: `tests/e2e/workbench.spec.ts`

1. Add a deterministic fixture mode that rejects one `turn/start` with the recoverable safe error, then permits a turn after provider replacement.
2. Add an E2E test for error display, no duplicate prompt, and successful explicit retry.
3. Run the new E2E test RED, implement only required fixture/runtime integration, and rerun GREEN.

## Task 5: Verification and Delivery

1. Run focused suites for JSON-RPC, runtime, HTTP, client, and E2E.
2. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, and `git diff --check`.
3. Run quality gate and obtain independent review.
4. Resolve Critical/Important findings with RED/GREEN tests.
5. Commit final documentation and push `feature/taskmux-text-v1` without including the separate ACP draft.
