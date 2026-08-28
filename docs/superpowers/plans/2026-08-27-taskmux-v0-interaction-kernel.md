---
feature_ids: [taskmux-v0-interaction-kernel]
topics: [taskmux, implementation, multi-agent, single-agent, ux]
doc_kind: plan
created: 2026-08-27
status: approved
source_spec: docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md
---

# TaskMux V0 Interaction Kernel Implementation Plan

**Feature:** `taskmux-v0-interaction-kernel` — `docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md`
**Goal:** Deliver a genuinely usable single named-Agent conversation as the `N = 1` slice of the future multi-Agent interaction system.
**Acceptance Criteria:** AC-1 through AC-12 from the approved design, reproduced below.
**Architecture cell:** N/A — standalone TaskMux repository; no ownership map exists.
**Map delta:** none
**Map delta why:** This change corrects TaskMux's own domain boundary without changing a shared architecture map.
**Architecture:** Keep the proven Codex App Server adapter and replace the collapsed Conversation model with `InteractionThread → AgentExecution → Provider Session`. Route commands and events by Execution identity, then rebuild the client projection around the same identity so a second Agent can be added without replacing the protocol, database, or timeline.
**Tech Stack:** TypeScript 7, Node 24, Fastify 5, SQLite, React 19, Vite 8, Vitest 4, Playwright, `react-markdown`, `remark-gfm`.
**前端验证:** Yes — unit/component tests plus Playwright and browser inspection are mandatory.

---

## Finish line

TaskMux can sustain real Codex multi-turn use with immediate visible feedback, safe rich text, informed approvals, recovery, and per-Execution ownership, while the persisted/API/event/client model already represents Agent identity separately from the Provider Session.

We are not building a second Agent, Claude/ACP support, automatic routing, Handoff UI, Tasks, Reviews, Session import, attachments, or syntax highlighting.

## Acceptance criteria

- **AC-1:** Sending shows the user message and named-Agent waiting state within 200 ms, without waiting for a Provider token.
- **AC-2:** Streamed text has no visible duplication, loss, or reordering; Markdown and fenced code are safe and readable.
- **AC-3:** Follow-scroll never interrupts a user who is reading history.
- **AC-4:** The user sees the concrete command or file-change information before accepting or declining.
- **AC-5:** Cancel, failure, retry, and SSE reconnect each have an explicit recoverable state.
- **AC-6:** Refresh and service restart restore history and continue the same Provider Session.
- **AC-7:** Public DTOs, events, client state, and the database distinguish Thread, AgentExecution, and Provider Session.
- **AC-8:** Turn ownership is isolated per Execution; no global single-turn assumption remains.
- **AC-9:** Existing Conversation data migrates losslessly and idempotently.
- **AC-10:** Unit/component tests, fake E2E, production build, and real Codex acceptance pass.
- **AC-11:** The V0 diff contains no ACP, Claude, or Provider selector implementation.
- **AC-12:** Historical V1 documents point to the approved design and only one active product truth source remains.

## Terminal schema

### Shared contracts

```ts
type ExecutionStatus = "idle" | "running" | "failed" | "interrupted"

type AgentExecutionSummary = {
  id: string
  threadId: string
  agentId: string
  displayName: string
  provider: "codex"
  status: ExecutionStatus
  createdAt: string
  updatedAt: string
}

type InteractionThreadSummary = {
  id: string
  title: string
  status: ExecutionStatus // pure projection from executions
  executions: AgentExecutionSummary[]
  createdAt: string
  updatedAt: string
}

type InteractionEventEnvelope = {
  threadId: string
  executionId: string
  agentId: string
  clientRequestId?: string
  seq: number
  payload: InteractionEvent
}

type MessageTurn = {
  id: string
  executionId: string
  agentId: string
  displayName: string
  role: "user" | "assistant"
  text: string
  status: "pending" | "completed" | "interrupted" | "failed"
}
```

The browser may read Execution identity but may never submit or change `externalSessionId`. Server routes obtain the Provider Session from the repository using `executionId`.

### SQLite v2

```sql
CREATE TABLE interaction_thread (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_execution (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES interaction_thread(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex')),
  external_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('idle','running','failed','interrupted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, agent_id)
);
```

Migration v2 copies each v1 `conversation` row into one Thread and one deterministic default Execution (`conversation.id || ':codex'`), preserves all fields, then removes the obsolete table in the same transaction. Re-running startup observes migration v2 and performs no duplicate copy.

## Stateful object gate

| Object | Owner | States | Terminal/derived rule |
|---|---|---|---|
| InteractionThread | Repository | absent, present | Status is derived; never stored on Thread. |
| AgentExecution | InteractionService | idle, running, failed, interrupted | Only owning service transitions running to terminal. |
| ActiveTurn | InteractionService memory | starting, running, cancelling, terminal | Keyed by `executionId`; operation identity rejects late events. |
| ApprovalRequest | Adapter + InteractionService | pending, accepting, declining, expired, terminal | Owner is `{threadId, executionId, operationId}`. |
| SendAttempt | Client store | optimistic, accepted, terminal, tombstone | Keyed by execution/request/stream epoch. |
| Event stream | `useEventStream` | connecting, connected, disconnected, reopened | Reopen advances epoch; does not cancel Provider work. |
| Follow-scroll | Message timeline | following, detached | Derived from viewport proximity; detached state is local only. |

### Required transitions

| Current | Event | Next | Required effect |
|---|---|---|---|
| absent Thread | create succeeds | present + idle Execution | Insert both records atomically after Provider Session creation. |
| idle/failed/interrupted Execution | send accepted | running | Acquire only that Execution's ActiveTurn. |
| running Execution | same Execution send | running | Reject with 409; preserve owner. |
| another running Execution | send | both running | Accept; no global lock. |
| starting/running Turn | cancel | cancelling | Dispatch at most one interrupt, including cancel-before-start response. |
| running/cancelling Turn | matching terminal event | terminal | Persist status, release approvals and ownership once. |
| terminal Turn | late/duplicate/old-operation event | terminal | Ignore; never revive state or text. |
| pending Approval | accept/decline/expire/adapter failure | terminal | Respond at most once and release owner. |
| connected stream | disconnect/reopen | disconnected/reopened | Keep accepted optimistic content and reconcile from list/detail. |
| following scroll | new content | following | Scroll to bottom. |
| detached scroll | new content | detached | Preserve reading position and show “回到底部”. |

### Invariants and test mapping

- **INV-1:** One Execution has exactly one immutable Provider Session identity — repository constraint and API body rejection tests.
- **INV-2:** A Thread supports multiple Executions; V0 creation adds one — repository projection test.
- **INV-3:** Turn locks are per Execution — two-Execution concurrency service and HTTP tests.
- **INV-4:** Only matching operation/turn events finish an owner — late, duplicate, and out-of-order event tests.
- **INV-5:** Thread status is a pure projection — repository list tests; no Thread status column.
- **INV-6:** Refresh/restart never duplicate transcript items — reducer race tests and restart E2E.
- **INV-7:** Approval detail stays out of logs and HTML — adapter sanitizer and component escaping tests.
- **INV-8:** Accept, decline, expiry, cancellation, and adapter crash release all ownership — service state matrix.
- **INV-9:** Each legacy Conversation becomes exactly one Thread and default Execution — migration fixture and repeat-open tests.
- **INV-10:** Thread/Execution metadata has no TTL — schema inspection test.
- **INV-11:** SSE disconnect cannot cancel an accepted turn — route/service disconnect regression test.
- **INV-12:** Client retry uses a fresh request identity and at most one optimistic pair — reducer/provider test.

## Implementation tasks

### Task 1: Establish the isolated branch and prove the baseline

**Files:** no product changes.

1. Create `/Users/sss/taskmux-v0-interaction-kernel` from clean commit `0fbd513` on branch `feature/taskmux-v0-interaction-kernel`.
2. Merge `main` to import the approved spec, ADR, and this plan; do not copy files from the dirty ACP worktree.
3. Run `env -u NODE_ENV pnpm install`.
4. Create ignored `.env` with `TASKMUX_PORT=3314`; TaskMux has no Redis dependency. Do not use ports 3003/3004 or Redis 6399.
5. Run `env -u NODE_ENV pnpm typecheck`, `NODE_ENV=test pnpm test`, `NODE_ENV=test pnpm test:e2e`, and `env -u NODE_ENV pnpm build`.
6. Expected: the known baseline is 356 unit/component passes, one skip, 10 Playwright passes, and a successful build. Any delta is diagnosed before implementation.

### Task 2: Migrate the database to Thread and Execution

**Files:**
- Modify: `src/server/database.ts`
- Modify: `src/server/database.test.ts`

1. RED: add a real v1 schema fixture containing idle/running/failed rows and assert v2 creates both terminal tables, preserves values, has no Thread status column, and maps each row once.
2. Run `NODE_ENV=test pnpm exec vitest run src/server/database.test.ts`; expect failures for missing v2 tables.
3. GREEN: add migration v2 exactly as the terminal SQL above, with copy/drop inside the existing explicit transaction.
4. Add RED tests for repeat-open idempotence and a forced mid-migration failure rollback; then implement only the transaction support required.
5. Run the focused test, then `NODE_ENV=test pnpm test`.
6. Commit `feat: migrate conversations to interaction executions` with Why and `[砚砚/gpt-5.6-sol🐾]`.

### Task 3: Introduce terminal contracts and repository projection

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/contracts.test.ts`
- Create: `src/server/interaction-repository.ts`
- Create: `src/server/interaction-repository.test.ts`
- Delete after replacement: `src/server/conversation-repository.ts`
- Delete after replacement: `src/server/conversation-repository.test.ts`

1. RED: contract decoder fixtures require Thread, Execution, Agent identity, and event envelope fields; reject browser-provided Provider Session fields.
2. RED: repository tests create one Thread/default Execution atomically, project status by priority `running > failed > interrupted > idle`, resolve by thread/execution/external session, update title, and interrupt all running Executions on startup.
3. Run both focused suites and confirm failures identify missing types/repository.
4. GREEN: implement the terminal DTOs and prepared statements. Keep `externalSessionId` only in the stored server type.
5. Refactor all repository naming away from Conversation; remove replaced files only when all imports compile.
6. Run focused tests, typecheck, and full unit tests.
7. Commit `refactor: model threads and agent executions`.

### Task 4: Move service, events, and HTTP ownership to Execution identity

**Files:**
- Create: `src/server/interaction-service.ts`
- Create: `src/server/interaction-service.test.ts`
- Delete after replacement: `src/server/conversation-service.ts`
- Delete after replacement: `src/server/conversation-service.test.ts`
- Modify: `src/server/event-hub.ts`
- Modify: `src/server/event-hub.test.ts`
- Modify: `src/server/http-routes.ts`
- Modify: `src/server/http-routes.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/main.ts`

1. RED: create two stored Executions with a controllable adapter. Assert same-Execution double send returns conflict while different Executions run concurrently.
2. RED: cover cancel-before-start, duplicate cancel, stale operation events, wrong turn IDs, adapter session failure, approval expiry, and startup recovery.
3. GREEN: key active/pending/cancelling maps by `executionId`; remove `activeConversationId`; resolve adapter events by external session, then enrich envelopes with Thread/Execution/Agent identity.
4. RED: HTTP tests require `/api/threads`, `/api/threads/:threadId`, and Execution-scoped message/cancel/approval routes. Request bodies cannot carry `agentId`, provider, or external session IDs.
5. GREEN: replace Conversation routes and event envelopes. Closing the last SSE client only unsubscribes; it does not cancel accepted turns.
6. Run service, hub, route, main, typecheck, and full suites.
7. Commit `feat: isolate turn ownership by agent execution`.

### Task 5: Surface informed approval details at the Adapter boundary

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/server/codex/codex-adapter.ts`
- Modify: `src/server/codex/codex-adapter.test.ts`
- Modify: `tests/fixtures/fake-app-server.mjs`

1. RED: command approval exposes command and cwd; file approval exposes path and bounded diff; unknown fields and secrets never cross the normalized contract.
2. RED: details longer than 20,000 code points are truncated with an explicit flag; missing detail uses a safe “details unavailable” state rather than fabricating content.
3. GREEN: cache only allow-listed item fields by `{externalSessionId, turnId, itemId}` and combine them with the matching server request. Clear the cache on terminal turn and transport failure.
4. Extend the fake server with deterministic command/cwd/file/diff fixtures.
5. Run adapter and full tests.
6. Commit `feat: expose bounded approval context`.

### Task 6: Rebuild the client projection around Thread and Execution

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Create: `src/client/interaction-store.tsx`
- Create: `src/client/interaction-store.test.tsx`
- Delete after replacement: `src/client/conversation-store.tsx`
- Delete after replacement: `src/client/conversation-store.test.tsx`
- Modify: `src/client/use-event-stream.ts`
- Modify: `src/client/use-event-stream.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/components/Composer.tsx`

1. RED: API decoders reject missing Thread/Execution/Agent identities and use the new Execution-scoped routes.
2. RED: reducer shows one optimistic user message plus one named-Agent pending bubble immediately; first text delta fills that bubble rather than appending a duplicate.
3. RED: store keys live state and in-flight send/cancel maps by Execution. An active Execution does not disable another Execution.
4. RED: accepted sends survive HTTP/SSE ordering, disconnect/reopen, Thread switching, and late detail responses. Retry creates a new request ID and one new optimistic pair.
5. GREEN: implement `interaction-store.tsx`, select the first Execution for V0, and remove `isAnyConversationRunning` from the send gate.
6. Add explicit UI states for “正在等待 Codex…”, elapsed wait, cancelling, reconnecting, failed, interrupted, and “重试上一条”.
7. Run focused client tests, typecheck, and the full suite.
8. Commit `feat: add execution-aware optimistic conversation state`.

### Task 7: Add safe Markdown, code copy, and follow-scroll

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/client/components/MarkdownMessage.tsx`
- Create: `src/client/components/MarkdownMessage.test.tsx`
- Create: `src/client/components/MessageTimeline.tsx`
- Create: `src/client/components/MessageTimeline.test.tsx`
- Modify: `src/client/components/Thread.tsx`
- Modify: `src/client/styles.css`

1. Install `react-markdown` and `remark-gfm` only; do not add `rehype-raw` or a syntax highlighter.
2. RED: GFM tables/lists/links render, fenced code shows its language and copy button, and raw HTML remains text/not executable.
3. GREEN: implement the Markdown renderer with a fenced-code copy control and accessible feedback.
4. RED: when within 80 px of the bottom, streaming content follows; after user scrolls upward it preserves position and shows “回到底部”.
5. GREEN: implement `MessageTimeline` with local derived follow state and no persisted scroll flag.
6. Run component tests and manually inspect long streaming Markdown in the isolated dev instance.
7. Commit `feat: render safe agent messages with follow scroll`.

### Task 8: Render informed approvals and recovery actions

**Files:**
- Modify: `src/client/components/ApprovalBar.tsx`
- Modify: `src/client/components/ApprovalBar.test.tsx`
- Modify: `src/client/components/Thread.tsx`
- Modify: `src/client/styles.css`

1. RED: command cards show command, cwd, truncation warning, and Agent name before buttons; file cards show targets and escaped plain-text diff.
2. RED: double clicks, expiry, rejection, and transport failure settle once and preserve actionable error text.
3. GREEN: render details with `<pre>`/text nodes only and connect retry/cancel actions to the selected Execution.
4. Run component and full tests.
5. Commit `feat: add informed approval and retry controls`.

### Task 9: Expand browser and real-Provider acceptance

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `tests/e2e/server.ts`
- Modify: `scripts/smoke-real-codex-support.ts`
- Modify: `scripts/smoke-real-codex.test.ts`
- Modify: `scripts/smoke-real-codex.ts`
- Create: `docs/acceptance/2026-08-28-taskmux-v0-real-codex.md`

1. RED E2E: assert pending feedback appears before delayed first token; Markdown/copy works; up-scroll is protected; command/file details precede decisions; retry is deduplicated; refresh and service restart continue the same Provider Session.
2. Add a fake-server two-Execution route test proving concurrent ownership even though the V0 UI exposes one Execution per newly created Thread.
3. GREEN: extend fixtures only as needed; run `NODE_ENV=test pnpm exec playwright test tests/e2e/workbench.spec.ts`.
4. RED smoke tests: replace one fixed 60-second budget with an overall deadline plus an inactivity watchdog reset by safe protocol/text/terminal events. Record first-visible-feedback, first-token, terminal latency, and transport outcome without raw sensitive data.
5. Before real acceptance, use the local Codex App Server help/schema as a time-boxed read-only Spike to confirm supported approval-policy fields; record the conclusion in the acceptance note.
6. In an explicitly disposable workspace, run ten short turns plus long streaming, cancel, retry, refresh/restart, and one command/file approval when the local schema supports deterministic prompting. Never point at production/user data.
7. If the Provider environment is unavailable, preserve the sanitized failure and timing evidence; do not relabel fake acceptance as real success.
8. Commit `test: verify the v0 interaction kernel end to end`.

### Task 10: Quality gate and scope proof

**Files:**
- Create: `docs/review-notes/2026-08-28-taskmux-v0-interaction-kernel-quality-gate.md`
- Modify after successful delivery: approved spec status/evidence fields only.

1. Run `env -u NODE_ENV pnpm typecheck`.
2. Run `NODE_ENV=test pnpm test`.
3. Run `NODE_ENV=test pnpm test:e2e`.
4. Run `env -u NODE_ENV pnpm build`.
5. Run the disposable real Codex acceptance and attach sanitized evidence.
6. Prove ACP freeze: `git diff --name-only 0fbd513...HEAD | rg '(^src/server/acp/|fake-acp|acp-dual-backend)'` must produce no output.
7. Inspect the UI in the isolated browser instance at its non-reserved port.
8. Map every AC and INV to test/log/screenshot evidence in the quality-gate note.
9. Request cross-individual review; do not self-approve or merge.

## Adversarial matrix

| Scenario | Test surface | Expected result |
|---|---|---|
| v1 DB migration crashes after Thread insert | database | Transaction rolls back; reopen creates one pair. |
| Two sends race on one Execution | service + HTTP | One accepted, one 409, one owner. |
| Two Executions send concurrently | service | Both accepted and independently terminal. |
| Old terminal event arrives during new Turn | service + reducer | Old event ignored by operation/turn identity. |
| SSE disconnects after HTTP acceptance | route + reducer | Turn continues; optimistic content survives and reconciles. |
| Approval is clicked twice or arrives after terminal | adapter + service + UI | At most one Provider response; clear expired state. |
| Adapter crashes with several active Executions | adapter + service | Only mapped active owners fail; all locks release. |
| User scrolls up during long stream | component + E2E | No forced jump; return-to-bottom affordance appears. |
| Markdown contains raw HTML/script | component | No HTML execution; safe text projection only. |
| Approval contains oversized/private fields | adapter | Allow-listed bounded detail only; no logging. |

## Open questions

No value-level open questions remain. Technical details such as the exact current Codex approval field names are resolved from the installed App Server schema during Task 9 and recorded as a bounded implementation decision.
