---
feature_ids:
  - taskmux-v0-interaction-kernel
  - taskmux-acp-providers
  - taskmux-session-management
topics: [taskmux, acp, codex, claude, sessions, multi-agent]
doc_kind: plan
created: 2026-08-30
status: approved
source_threads:
  - thread_mtbh922hu8iqtyum
---

# TaskMux ACP Providers and Session Management Implementation Plan

**Feature:** `docs/superpowers/specs/2026-08-30-taskmux-acp-providers-and-session-management-design.md`
**Goal:** Deliver a production-usable N=1 interaction slice over Claude and Codex ACP, then add persistent TaskMux session management without collapsing Thread, Execution, and Provider Session identities.
**Acceptance Criteria:** AC-1 through AC-16 from the approved design, including the B × C activity hierarchy, thought privacy, non-overlapping Composer geometry, real-provider gates, and independent review for Deliveries A, B, and C.
**Architecture cell:** N/A — this repository does not yet maintain `docs/architecture/ownership/`.
**Map delta:** none
**Map delta why:** The approved spec is the ownership truth source for this prototype; adding a second architecture registry would duplicate it.
**Architecture:** `InteractionService` owns Thread, Execution, Turn, and Approval lifecycles. A provider-keyed `ProviderRuntimeRegistry` owns independent ACP subprocesses and resolves a provider-neutral adapter; SQLite stores permanent TaskMux identities while ACP sessions remain the source of message history.
**Tech Stack:** Node.js 24, TypeScript 7, Fastify, React 19, SQLite, Agent Client Protocol TypeScript SDK 1.3, Vitest, React Testing Library, Playwright.
**前端验证:** Yes — component tests, isolated Playwright, and browser verification are required.

---

## Finish line

TaskMux can create, resume, use, rename, archive, and restore permanent Codex or Claude conversations; both providers can run concurrently without state leakage; raw Codex App Server code is gone only after old-session ACP continuation passes; and the N=1 experience presents pure chat as a B answer bubble, real tool work as a turn-scoped collapsible C activity module above that bubble, private reasoning as no user-facing chain-of-thought, and a Composer that never covers the message viewport. Waiting, Markdown, copy, scroll, cancel, retry, informed approval, refresh, and restart all pass fake and real-provider acceptance.

Not building: a second Agent in one Thread, `@Agent` routing, Handoff UI, provider switching after creation, external CLI session import, automatic provider fallback, permanent deletion, search, tags, folders, or hosted credentials.

## Terminal schema

```ts
type Provider = "codex" | "claude"

type ProviderAvailability = {
  provider: Provider
  status: "available" | "unavailable"
  diagnostic?: { code: string; message: string }
}

type InteractionThreadSummary = {
  id: string
  title: string
  status: ExecutionStatus
  archivedAt: string | null
  executions: AgentExecutionSummary[]
  createdAt: string
  updatedAt: string
}

type StoredAgentExecution = AgentExecutionSummary & {
  externalSessionId: string
}

type TurnActivity = {
  id: string
  kind: "tool"
  label: string
  status: "running" | "completed" | "failed" | "declined"
}

type InteractionMessageTurn = MessageTurn & {
  executionId: string
  agentId: string
  displayName: string
  activities: TurnActivity[]
}

interface ProviderAgentAdapter extends AgentAdapter {
  readonly provider: Provider
  getAvailability(): Promise<ProviderAvailability>
  closeSession(externalSessionId: string): Promise<void>
  deleteSession(externalSessionId: string): Promise<void>
}

interface ProviderRuntimeRegistry {
  get(provider: Provider): Promise<ProviderAgentAdapter>
  listAvailability(): Promise<ProviderAvailability[]>
  shutdown(): Promise<void>
}
```

The browser receives `provider` but never receives a writable `externalSessionId`. Thread status remains a pure projection of Execution statuses; no duplicate stored thread status is introduced.

## Stateful object census and invariants

### S1 — Provider runtime

Lifecycle owner: `ProviderRuntimeRegistry`.

| State | Event | Next state | Required effect |
|---|---|---|---|
| stopped | first `get` | starting | spawn only the selected provider |
| starting | initialize succeeds | ready | cache one runtime per provider |
| starting | initialize fails | unavailable | sanitize diagnostic; do not affect peer provider |
| ready | unexpected exit | restarting | fail only mapped active turns; settle approvals once |
| restarting | within budget succeeds | ready | future load/resume allowed; never replay prompt |
| restarting | budget exhausted | unavailable | preserve sessions and expose actionable status |
| any | app shutdown | stopping → stopped | reject new work, settle approvals, stop child once |

- INV-1: at most one live child per Provider; measured by concurrent-start tests.
- INV-2: one Provider failure never mutates the peer runtime; measured by dual-provider crash tests.
- INV-3: restart never invokes `session/prompt`; measured by fake ACP request log.
- INV-4: browser diagnostics contain no stderr, tokens, env values, or Session IDs; measured by API contract tests.

Adversarial tests: concurrent `get`; exit during initialize; exit with two sessions; repeated exit beyond budget; shutdown racing restart.

### S2 — Provider session binding and create request

Lifecycle owner: `InteractionService`; persisted by `InteractionRepository`; runtime only creates/loads/resumes/closes the external Session.

| State | Event | Next state | Required effect |
|---|---|---|---|
| absent | create request starts | creating | reserve `clientRequestId` |
| creating | ACP `session/new` succeeds | provider-created | hold identity server-side only |
| provider-created | DB transaction commits | visible | persist Thread + Execution atomically |
| provider-created | DB transaction fails | absent/orphan-diagnostic | best-effort close/delete once |
| visible | load/resume succeeds | active | continue the same Session |
| visible | Provider says missing | unavailable | keep metadata; never create replacement |
| visible | archive | archived | persist first, then best-effort close |
| archived | restore | visible | clear archive marker only; lazy load/resume |

- INV-5: one `(provider, clientRequestId)` creates at most one Thread and one Session.
- INV-6: an Execution's Provider and external Session identity are immutable.
- INV-7: no successful API response can reference an uncommitted Thread.
- INV-8: archive and provider-close failures cannot delete metadata or history.
- INV-9: external Session identity has no public write path.

Adversarial tests: duplicated/retried HTTP create; database failure after `session/new`; crash before response; missing Session on load; repeated restore; provider field smuggled through PATCH.

### S3 — Active turn

Lifecycle owner: `InteractionService`, keyed by `executionId`.

| State | Event | Next state | Required effect |
|---|---|---|---|
| idle | accepted prompt | starting | publish/retain client request identity |
| starting | prompt accepted or first matching update | running | bind operation/turn once |
| starting/running | cancel | cancelling | send one cancel to owning Provider Session |
| running | matching terminal | idle/failed/interrupted | release lock and approvals once |
| running | duplicate/late/foreign update | unchanged | ignore for ownership and terminal state |
| running | owning runtime exits | failed | do not affect other Executions |

- INV-10: at most one active turn per Execution; different Executions may run concurrently.
- INV-11: only current Session + operation/epoch events can mutate a turn.
- INV-12: terminal paths settle state, locks, and approvals at most once.
- INV-13: retry creates a new request identity and one new optimistic message pair.
- INV-13a: every public tool event carries the owning `turnId`; an activity can mutate only that Assistant Turn.
- INV-13b: `agent_thought_chunk` content is dropped at the ACP adapter boundary and cannot enter public events, ordinary logs, browser state, or message history.

Adversarial tests: cancel before prompt response; late old terminal after retry; duplicate terminal; foreign Session update; provider crash during approval.

### S4 — Pending approval

Lifecycle owner: `InteractionService`, keyed by ACP request ID and bound to Provider + Thread + Execution + operation.

- INV-14: only the owning Execution can answer an approval.
- INV-15: decline, cancel, timeout, runtime exit, and turn terminal settle it at most once.
- INV-16: command/cwd and file/diff details are bounded and workspace-safe before publication.

Adversarial tests: duplicate browser response; expired request; response from wrong Execution; symlink escape; runtime exit while response is in flight.

### S5 — Client interaction view

Lifecycle owner: `InteractionStore`; server events are authoritative after HTTP acceptance.

- INV-17: thread/execution event identity prevents cross-session state leakage.
- INV-18: history replay epoch cannot duplicate live content.
- INV-19: user messages and waiting bubbles render immediately, but a Thread is not persisted optimistically before create succeeds.
- INV-20: auto-scroll follows only while the user is already near the bottom.
- INV-21: pure chat retires transient Thinking and leaves only its B answer bubble; real tool activity remains attached to the owning Assistant Turn and restores after refresh.
- INV-22: Header, message viewport, and Composer occupy separate layout rows at desktop and narrow widths; the viewport owns scrolling and the Composer never overlays it.

Adversarial tests: switch threads during a stream; reconnect replay overlaps live epoch; send fails before first token; retry after terminal failure; upward scroll during streaming.

## Delivery A — Claude ACP vertical slice

### Task A1: Preserve and finish the Execution-aware client seam

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Create: `src/client/interaction-store.tsx`
- Modify: `src/client/interaction-store.test.tsx`
- Modify: `src/client/use-event-stream.ts`
- Modify: `src/client/use-event-stream.test.tsx`

1. Run the existing uncommitted API/store tests and record the intended Red failures.
2. Complete strict decoding for Thread, Execution, and event identities; accept both providers.
3. Implement reducer ownership by `threadId + executionId`, request identity, history epoch, and retry semantics.
4. Run `pnpm vitest run src/client/api.test.ts src/client/interaction-store.test.tsx src/client/use-event-stream.test.tsx`.
5. Commit `feat: finish execution-aware client state`.

Demo: two fake Executions stream independently, and stale/foreign events cannot settle the selected one.

### Task A2: Extend permanent schema without duplicating derived state

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/contracts.test.ts`
- Modify: `src/server/database.ts`
- Modify: `src/server/database.test.ts`
- Modify: `src/server/interaction-repository.ts`
- Modify: `src/server/interaction-repository.test.ts`

1. Add failing migrations for `provider IN ('codex','claude')`, `archived_at`, and idempotent create-request identity.
2. Verify the migration tests fail on the current schema.
3. Implement a forward-only migration that preserves existing Codex bindings and projects Thread status from Executions.
4. Add repository transactions for idempotent create, provider immutability, archive/restore, and active/archived filtering.
5. Run repository and contract tests, then commit `feat: persist provider and archive identities`.

Demo: a migrated database retains old Codex IDs while new Claude rows and archive state survive reopen.

### Task A3: Add a deterministic ACP transport and fake agent

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/server/acp/acp-runtime.ts`
- Create: `src/server/acp/acp-runtime.test.ts`
- Create: `src/server/acp/acp-types.ts`
- Create: `tests/fixtures/fake-acp-agent.mjs`

1. Add failing tests for initialize, capability validation, new/load/resume/close/delete, prompt/update/cancel, permission, malformed frames, exit, and bounded diagnostics.
2. Run them against the missing runtime and confirm Red.
3. Add the pinned ACP SDK and a stdio runtime using `spawn(command, args, { cwd, env, shell: false })` plus SDK NDJSON transport.
4. Keep raw stderr only in a bounded server-side diagnostic buffer and expose stable sanitized codes.
5. Run focused tests and commit `feat: add ACP subprocess runtime`.

Demo: the fake agent serves multiple Sessions over one child and reports isolated events.

### Task A4: Normalize ACP into the existing AgentAdapter contract

**Files:**
- Modify: `src/server/agent/agent-adapter.ts`
- Create: `src/server/acp/acp-adapter.ts`
- Create: `src/server/acp/acp-adapter.test.ts`
- Modify: `src/shared/contracts.ts`

1. Write parameterized failing tests for Claude and Codex update shapes, including history replay, text, tools, approval, cancel, terminal, late/duplicate/foreign updates, and session failure.
2. Add an operation/epoch-aware `AcpAgentAdapter`; do not encode provider names into `InteractionService` event logic.
3. Map permissions to bounded command/file/generic approval cards and map stop reasons to completed/interrupted/failed.
4. Run adapter tests and commit `feat: normalize ACP sessions and permissions`.

Demo: one adapter contract drives both fake provider configurations.

### Task A5: Isolate Provider runtimes and route InteractionService

**Files:**
- Create: `src/server/agent/provider-runtime-registry.ts`
- Create: `src/server/agent/provider-runtime-registry.test.ts`
- Modify: `src/server/interaction-service.ts`
- Modify: `src/server/interaction-service.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/main.ts`
- Modify: `src/server/main.test.ts`

1. Write failing INV-1 through INV-16 service/registry tests, including concurrent start, create compensation, cross-provider parallel turns, and one-provider crash.
2. Implement lazy provider resolution and provider-specific restart budgets; never auto-fallback or replay prompts.
3. Route every session call from the persisted Execution provider; compensate a failed DB create with close/delete.
4. Preserve raw Codex adapter behind the registry only for Delivery A.
5. Run registry/service/main tests and commit `feat: route interactions through provider runtimes`.

Demo: Claude and raw Codex conversations run at the same time; killing Claude does not lock Codex.

### Task A6: Expose provider-aware creation and availability

**Files:**
- Modify: `src/server/http-routes.ts`
- Modify: `src/server/http-routes.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`

1. Write failing tests for `GET /api/providers` and idempotent `POST /api/threads { provider, clientRequestId }`.
2. Add strict request guards; reject unknown keys, provider mutation, Session identity, and unavailable providers.
3. Return stable sanitized diagnostics without changing global health.
4. Run API tests and commit `feat: expose provider-aware thread creation`.

Demo: retrying the same create request returns one permanent Thread and one provider Session.

### Task A7: Complete the N=1 conversation experience

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/components/Thread.tsx`
- Modify: `src/client/components/Composer.tsx`
- Modify: `src/client/components/ApprovalBar.tsx`
- Create: `src/client/components/MarkdownMessage.tsx`
- Create: `src/client/components/MarkdownMessage.test.tsx`
- Modify: `src/client/styles.css`

1. Write failing component tests for provider chooser/diagnostics, named waiting state, retry identity, safe GFM/code copy, and bottom-follow scroll protection.
2. Add a small audited Markdown renderer dependency with raw HTML disabled.
3. Wire the completed InteractionStore into App; only the selected Execution Composer locks.
4. Render bounded approval detail and provider badges without exposing Session IDs.
5. Run client tests and commit `feat: complete provider-aware conversation UX`.

Demo: before first token the named Agent is visibly waiting; code copies; user scroll position is respected.

### Task A8: Bind activity to turns and finish the B × C conversation hierarchy

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/contracts.test.ts`
- Modify: `src/server/agent/agent-adapter.ts`
- Modify: `src/server/acp/acp-adapter.ts`
- Modify: `src/server/acp/acp-adapter.test.ts`
- Modify: `src/server/codex/codex-adapter.ts`
- Modify: `src/server/codex/codex-adapter.test.ts`
- Modify: `src/server/interaction-service.ts`
- Modify: `src/server/interaction-service.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/use-event-stream.ts`
- Modify: `src/client/use-event-stream.test.tsx`
- Modify: `src/client/interaction-store.tsx`
- Modify: `src/client/interaction-store.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/components/Thread.tsx`
- Modify: `src/client/components/Thread.test.tsx`
- Create: `src/client/components/ActivityModule.tsx`
- Create: `src/client/components/ActivityModule.test.tsx`
- Create: `src/client/components/ThinkingIndicator.tsx`
- Create: `src/client/components/ThinkingIndicator.test.tsx`
- Delete: `src/client/components/ToolLine.tsx`
- Delete: `src/client/components/ToolLine.test.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/fixtures/fake-acp-agent.mjs`
- Modify: `tests/e2e/workbench.spec.ts`

#### A8.1 — Make turn ownership and thought privacy contractual

1. Add Red contract/API/SSE tests for `TurnActivity`, mandatory `InteractionMessageTurn.activities`, and `{ type: "tool_status"; turnId; tool }`. Reject missing/blank `turnId`, invalid activity kinds/statuses, activities on a user Turn, and every public event shaped like `agent_thought_chunk` or carrying thought text.
2. Add `TurnActivity` to the shared contract; make history adapters return normalized activities with every Turn and make the browser decoder require `activities: []` even for pure chat.
3. Update raw Codex history projection to return `activities: []` so Delivery A remains compatible without inventing tool history that the old transport cannot prove.
4. Run `pnpm vitest run src/shared/contracts.test.ts src/client/api.test.ts src/client/use-event-stream.test.tsx src/server/codex/codex-adapter.test.ts` and commit the contract seam with the rest of A8, not as an independently shippable schema.

#### A8.2 — Normalize live and replayed ACP activity without exposing thought text

1. Add Red adapter tests showing that live `tool_call` / `tool_call_update` produce `tool_status` with the current operation as `turnId`, repeated updates keep one activity identity, replayed tool updates attach to the following/current Assistant Turn in stream order, and `agent_thought_chunk` produces no listener event and no history text.
2. Extend the replay collector to maintain an ordered pending activity map. User message chunks start a user Turn; tool events accumulate normalized activities for the in-progress assistant response; agent message chunks create or extend that Assistant Turn and receive those activities. A replay containing tool activity but no Assistant message emits no orphan activity Turn.
3. Preserve only `id`, `kind: "tool"`, bounded display label, and normalized status. Do not persist or publish raw input, raw output, thought content, command text, Diff, or Provider metadata through this projection.
4. Extend the fake ACP agent so `session/load` replays text and tool updates in their original order. Add refresh/restart adapter tests proving the same completed activity returns on the same Assistant Turn.
5. Run `pnpm vitest run src/server/acp/acp-adapter.test.ts src/server/interaction-service.test.ts`.

If either real Provider fails to replay stable tool events during Task A9, Delivery A remains Red. Add a server-side normalized activity projection only after that failure is reproduced and covered by a repository test; never silently accept lost C modules or duplicate full message persistence.

#### A8.3 — Replace Execution-global tools with per-Turn activity state

1. Add Red reducer tests for two sequential Turns in one Execution, interleaved events in different Executions, an event with the wrong `turnId`, optimistic Assistant ID rebinding, terminal completion, detail refresh, and reconnect. Assert that one Turn can never display another Turn's activity.
2. Replace `toolsById` / `toolOrder` with `activitiesByTurnId: Record<string, { byId: Record<string, TurnActivity>; order: string[] }>` and replace `selectTools(state, executionId)` with `selectActivities(state, executionId, turnId)`.
3. On `turn_started`, atomically move the optimistic Assistant Turn and any pre-bound activity bucket to the authoritative `turnId`. Accept `tool_status` only when its `turnId` can bind to the current request attempt; ignore stale, terminal, or foreign Turn activity.
4. Make `selectDisplayedTurns` merge transient activity state onto live Assistant Turns while persisted detail already carries its own `activities`. Retiring optimistic Turns after a successful detail load must not retire an active Turn or duplicate restored activities.
5. Run `pnpm vitest run src/client/interaction-store.test.tsx src/client/App.test.tsx`.

#### A8.4 — Render Thinking, C activity, and B answer as one Turn

1. Add Red component tests with fake timers: the named empty Assistant placeholder exists immediately; Thinking text is absent at 399ms and visible at 400ms; first text suppresses/removes Thinking; first tool activity replaces Thinking with C; pure-chat completion leaves only B; tool completion leaves a collapsed C summary directly above B.
2. Implement `ThinkingIndicator` as a cancellable 400ms presentation timer. Its only fallback copy is `{displayName} 正在思考…` plus `等待模型响应`; it consumes no raw provider reasoning.
3. Implement `ActivityModule` as a semantic list within the owning Assistant Turn wrapper. It is expanded while any activity is running or awaiting approval, collapses after terminal completion, retains explicit icon + text status, and exposes a button with `aria-expanded` for completed detail.
4. Render each Assistant Turn as `ActivityModule` then B message bubble inside one `.assistant-turn` container. Delete the Execution-global tool list and `ToolLine`; approvals remain explicit bounded interaction UI associated with the active Turn.
5. Run `pnpm vitest run src/client/components/ThinkingIndicator.test.tsx src/client/components/ActivityModule.test.tsx src/client/components/Thread.test.tsx src/client/App.test.tsx`.

#### A8.5 — Move Composer into a non-overlapping three-row layout

1. Add a Red Playwright geometry assertion at `1280×720` and `390×720`: `messageViewport.bottom <= composer.top`, the last message can scroll fully above the Composer, and the Composer remains inside the visible work area.
2. Make `.thread` a height-constrained grid with `grid-template-rows: auto minmax(0, 1fr) auto`; move approvals/errors into the third-row interaction rail with the Composer or reserve explicit rows without overlay.
3. Set `.message-viewport { min-height: 0; max-height: none; overflow-y: auto; }` and `.composer { position: static; bottom: auto; }`. Remove the narrow-screen `52vh` cap and preserve one near-bottom scroll policy for text, Thinking, activity expansion/collapse, and approvals.
4. Run the focused Playwright test, then `pnpm typecheck && pnpm build`.
5. Commit `feat: add turn-scoped agent activity UX`.

Demo: a pure chat Turn shows only B after completion; a tool Turn shows C above its B bubble, collapses on completion, survives refresh, and never displays raw thought text. At both acceptance viewports, the final reply is fully visible above the Composer.

### Task A9: Fake and real Claude acceptance

**Files:**
- Modify: `tests/e2e/server.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Create: `scripts/smoke-real-acp-support.ts`
- Create: `scripts/smoke-real-claude.ts`
- Create: `scripts/smoke-real-claude.test.ts`
- Modify: `README.md`

1. Add failing E2E for create/switch/stream/cancel/approval/refresh/restart/retry and no cross-provider leakage.
2. Make the isolated E2E harness launch the fake ACP provider on non-reserved ports.
3. Add an opt-in real Claude smoke using a temporary Workspace and sanitized latency report.
4. Run unit, component, E2E, typecheck, build, and real Claude ten-turn acceptance, including one tool Turn restored after refresh and process restart.
5. Commit `test: accept Claude ACP vertical slice`.
6. Run `quality-gate`, then request independent review before Delivery A merge.

## Delivery B — Codex ACP migration

### Task B1: Put Codex on the shared ACP contract

**Files:**
- Modify: `src/server/agent/provider-runtime-registry.ts`
- Modify: `src/server/acp/acp-adapter.test.ts`
- Modify: `src/server/interaction-service.test.ts`
- Modify: `tests/fixtures/fake-acp-agent.mjs`

1. Parameterize every ACP contract case over `codex` and `claude` and observe Codex-specific gaps as Red.
2. Configure `codex-acp` through the same runtime and adapter with only binary/env/label differences.
3. Verify parallel prompts, approvals, cancellation, restart isolation, and history replay.
4. Commit `feat: run Codex through shared ACP runtime`.

### Task B2: Prove old Codex Session continuity before deletion

**Files:**
- Create: `scripts/verify-codex-acp-migration.ts`
- Create: `scripts/verify-codex-acp-migration.test.ts`
- Modify: `src/server/database.test.ts`
- Modify: `README.md`

1. Capture an isolated raw Codex Thread ID, then load and continue it through `codex-acp`.
2. Fail closed if the loaded history, cwd, or continued turn identity differs.
3. Record only sanitized outcome and latency; never persist message bodies or credentials in logs.
4. Commit `test: prove Codex ACP session continuity`.

### Task B3: Remove the raw Codex stack

**Files:**
- Delete: `src/server/codex/json-rpc-client.ts`
- Delete: `src/server/codex/json-rpc-client.test.ts`
- Delete: `src/server/codex/codex-adapter.ts`
- Delete: `src/server/codex/codex-adapter.test.ts`
- Delete: `src/server/codex/codex-types.ts`
- Delete: `src/server/codex/codex-diagnostics.ts`
- Delete: `src/server/codex/codex-diagnostics.test.ts`
- Delete: `tests/fixtures/fake-app-server.mjs`
- Modify: `src/server/app.ts`
- Modify: `src/server/main.ts`
- Modify: `scripts/smoke-real-codex.ts`
- Modify: `README.md`

1. First make the shared ACP suite and old-session migration gate green.
2. Delete raw-only composition, implementation, fixtures, and tests; retain behavior tests at the provider-neutral level.
3. Run `rg` to prove no raw App Server method names or permanent dual-track flags remain.
4. Run all gates plus real Codex acceptance and commit `refactor: remove raw Codex transport`.
5. Run `quality-gate`, then request independent review before Delivery B merge.

## Delivery C — TaskMux session management

### Task C1: Add rename, archive, restore, and filtered list lifecycle

**Files:**
- Modify: `src/server/interaction-repository.ts`
- Modify: `src/server/interaction-repository.test.ts`
- Modify: `src/server/interaction-service.ts`
- Modify: `src/server/interaction-service.test.ts`
- Modify: `src/server/http-routes.ts`
- Modify: `src/server/http-routes.test.ts`

1. Write failing tests for Unicode title validation, active/archived views, running archive conflict, close-after-commit, close failure, and idempotent restore.
2. Implement repository transitions in transactions and best-effort runtime close after archive commit.
3. Reject unknown PATCH fields and every attempt to mutate provider/Session identity.
4. Run server tests and commit `feat: manage persistent TaskMux sessions`.

### Task C2: Add session-management UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/interaction-store.tsx`
- Modify: `src/client/interaction-store.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/styles.css`

1. Write failing tests for active/archived lists, switch, inline rename, disabled-running archive, restore, and HTTP rollback.
2. Implement actions so persistence changes only after accepted HTTP responses.
3. Keep streaming state keyed by Thread/Execution while switching views.
4. Run client tests and commit `feat: add TaskMux session management UI`.

### Task C3: Final concurrent and durability acceptance

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `scripts/smoke-real-claude.ts`
- Modify: `scripts/smoke-real-codex.ts`
- Modify: `README.md`

1. Add E2E for rename/archive/restore persistence, two-provider concurrency, independent cancel/approval, refresh, server restart, runtime restart, and history preservation.
2. Run all deterministic gates in an isolated data directory and ports other than 3003/3004.
3. Run real Claude and Codex ten-turn matrices in disposable Workspaces, including command/file approvals and Session continuation.
4. Run `quality-gate`; verify AC-1 through AC-16 and vision wording against the original thread.
5. Request independent review for Delivery C, address findings through `receive-review`, and only then enter `merge-gate`.

## Verification commands

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
pnpm smoke:claude
pnpm smoke:codex
pnpm vitest run src/shared/contracts.test.ts src/server/acp/acp-adapter.test.ts src/client/interaction-store.test.tsx src/client/components/Thread.test.tsx
rg -n 'thread/start|turn/start|item/commandExecution|CodexJsonRpcClient|CodexAppServerAdapter' src tests scripts
rg -n 'agent_thought_chunk|thought.*text|reasoning.*text' src/client src/shared
```

Expected final result: all deterministic and real-provider gates pass; B and C remain turn-scoped across refresh/restart; Composer geometry never overlaps at either viewport; the final `rg` returns no raw-stack implementation references and no browser-facing raw thought projection; public contract probes contain no external Session identity; each delivery has an independent review record.

## Open questions resolved autonomously

- Technical OQ: use the ACP 1.3 stable TypeScript SDK API and pin the exact tested version.
- Technical OQ: if `session/delete` is unavailable, close the invisible Session and record an orphan diagnostic; do not weaken create atomicity or expose it.
- Technical OQ: keep provider process environment allow-listed and inherit only variables required for provider authentication/runtime.
- Value OQ: none. Provider order, creation model, session-management scope, persistence, and no-more-decision boundary were approved by the co-creator.
