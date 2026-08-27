---
feature_ids: [taskmux-historical-text-workbench-v1]
topics: [taskmux, codex, implementation, product-history]
doc_kind: archived-plan
created: 2026-08-23
superseded_by: docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md
---

# TaskMux Text Workbench V1 Implementation Plan

> **已被取代。** 本计划仅用于解释现有实现的来源，不再驱动新的开发工作。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent local web workbench that runs one real Codex App Server, supports TaskMux-created text conversations, streams replies, handles minimal tool approvals, and resumes completed history after refresh or restart.

**Architecture:** A single strict-TypeScript project contains a Fastify server, React/Vite client, and shared DTOs. The server owns SQLite metadata, a provider-neutral `AgentAdapter`, the V1 `CodexAppServerAdapter`, conversation state, and an SSE event hub; Codex remains the source of truth for message bodies.

**Tech Stack:** Node.js 24 LTS, pnpm 9, TypeScript, React, Vite, Fastify, `node:sqlite`, Server-Sent Events, Vitest, React Testing Library, Playwright.

## Global Constraints

- One TaskMux process binds exactly one absolute Workspace passed as `--workspace`.
- HTTP listens on `127.0.0.1` only; the browser cannot change Workspace, Codex binary, cwd, or external thread id.
- V1 supports one Codex CLI, text input/output, TaskMux-created conversations, one-line tool states, and command/file-change accept or decline.
- V1 does not use ACP; all provider-specific JSON-RPC stays inside `CodexAppServerClient` and `CodexAppServerAdapter`.
- SQLite stores conversation metadata only; message bodies come from `thread/read(includeTurns=true)`.
- Each conversation and the whole process permit at most one active turn.
- Refresh restores completed history but interrupts an active turn; no SSE replay or partial-turn reconnection.
- Tests use isolated temporary workspaces and data directories. Automated tests never read or write the operator's Codex history.
- Work proceeds Red–Green–Refactor, and every task ends with focused verification and a commit.

## Planned File Structure

```text
package.json                         scripts and pinned package manager
tsconfig.json                        shared/client type checking
tsconfig.server.json                 Node build output
vite.config.ts                       browser build and test config
vitest.config.ts                     unit/component test projects
playwright.config.ts                 browser E2E configuration
src/shared/contracts.ts              public DTOs and events
src/shared/contracts.test.ts         runtime guard tests
src/server/config.ts                 CLI/env parsing and fixed workspace
src/server/data-dir.ts               OS app-data path resolution
src/server/database.ts               SQLite open/migrate lifecycle
src/server/conversation-repository.ts metadata persistence
src/server/agent/agent-adapter.ts     provider-neutral interface
src/server/codex/json-rpc-client.ts   stdio process and request correlation
src/server/codex/codex-types.ts       private App Server wire types
src/server/codex/codex-adapter.ts     Codex-to-domain normalization
src/server/conversation-service.ts    use cases, locks, title, recovery
src/server/event-hub.ts               sequenced SSE fan-out
src/server/http-routes.ts             REST and SSE endpoints
src/server/app.ts                     dependency composition for tests
src/server/main.ts                    production/development entrypoint
src/client/api.ts                     typed HTTP client
src/client/conversation-store.tsx     reducer and context
src/client/use-event-stream.ts        SSE subscription
src/client/App.tsx                    page shell
src/client/components/Sidebar.tsx     conversation navigation
src/client/components/Thread.tsx      text history and live turn
src/client/components/Composer.tsx    send/cancel controls
src/client/components/ToolLine.tsx    compact tool state
src/client/components/ApprovalBar.tsx minimal approval controls
src/client/styles.css                 workbench layout and states
src/client/main.tsx                   React entrypoint
index.html                            Vite document
tests/fixtures/fake-app-server.mjs    deterministic JSONL subprocess
tests/e2e/server.ts                   isolated E2E server harness
tests/e2e/workbench.spec.ts           complete browser journey
scripts/smoke-real-codex.ts           opt-in real Codex check
README.md                             setup, run, test, limitations
```

---

### Task 1: Project foundation and fixed Workspace configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/server/config.ts`
- Create: `src/server/config.test.ts`
- Create: `src/server/data-dir.ts`
- Create: `src/server/data-dir.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `parseServerConfig(argv, env): ServerConfig`
- Produces: `resolveDataDir(env, platform, homeDir): string`
- `ServerConfig = { workspace: string; host: "127.0.0.1"; port: number; dataDir: string; dev: boolean }`

- [ ] **Step 1: Write failing configuration tests**

```ts
it("normalizes one absolute workspace", () => {
  expect(parseServerConfig(["--workspace", fixtureDir], {})).toMatchObject({
    workspace: realpathSync(fixtureDir),
    host: "127.0.0.1",
  })
})

it("rejects a missing or relative workspace", () => {
  expect(() => parseServerConfig([], {})).toThrow("--workspace is required")
  expect(() => parseServerConfig(["--workspace", "relative"], {})).toThrow(
    "Workspace must be an absolute path"
  )
})
```

- [ ] **Step 2: Run the focused tests and confirm Red**

Run: `pnpm vitest run src/server/config.test.ts src/server/data-dir.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Add the minimal project configuration and dependencies**

Use `pnpm add fastify @fastify/static @fastify/middie react react-dom` and
`pnpm add -D typescript vite @vitejs/plugin-react tsx vitest jsdom @types/node @types/react @types/react-dom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test`.

Set scripts exactly:

```json
{
  "scripts": {
    "dev": "tsx watch src/server/main.ts",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist-server/server/main.js",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.server.json --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "smoke:codex": "tsx scripts/smoke-real-codex.ts"
  },
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=24" }
}
```

Configure Vite with `build.outDir = "dist/client"`. Configure the server
TypeScript build with `rootDir = "src"` and `outDir = "dist-server"`.

- [ ] **Step 4: Implement configuration and data-directory resolution**

`parseServerConfig` must resolve the workspace with `realpathSync`, verify it is a directory, accept `--port` only in `1..65535`, force host to `127.0.0.1`, and use `TASKMUX_DATA_DIR` only for the server-owned data location. `resolveDataDir` must choose `~/Library/Application Support/TaskMux` on macOS, `%LOCALAPPDATA%/TaskMux` on Windows, and `$XDG_DATA_HOME/taskmux` or `~/.local/share/taskmux` on Linux.

- [ ] **Step 5: Run foundation verification**

Run: `pnpm vitest run src/server/config.test.ts src/server/data-dir.test.ts && pnpm typecheck`

Expected: all tests pass and both TypeScript configurations report zero errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts .gitignore src/server/config.ts src/server/config.test.ts src/server/data-dir.ts src/server/data-dir.test.ts
git commit -m "chore: scaffold TaskMux server and client"
```

---

### Task 2: Shared contracts and SQLite conversation repository

**Files:**
- Create: `src/shared/contracts.ts`
- Create: `src/shared/contracts.test.ts`
- Create: `src/server/database.ts`
- Create: `src/server/database.test.ts`
- Create: `src/server/conversation-repository.ts`
- Create: `src/server/conversation-repository.test.ts`

**Interfaces:**
- Produces: `ConversationSummary`, `MessageTurn`, `ConversationDetail`, `ToolStatus`, `ApprovalRequest`, `ConversationEvent`, and `ConversationEventEnvelope`
- Produces: `openDatabase(path): DatabaseSync`
- Produces: `ConversationRepository.create`, `.list`, `.getById`, `.getByExternalSessionId`, `.updateTitle`, `.setStatus`, `.interruptRunning`

- [ ] **Step 1: Write failing repository and migration tests**

```ts
it("creates, lists, and uniquely maps an external session", () => {
  const repo = createTestRepository()
  repo.create({ id: "c1", externalSessionId: "thr_1" })
  expect(repo.list()[0]).toMatchObject({
    id: "c1",
    title: "新会话",
    status: "idle",
  })
  expect(() => repo.create({ id: "c2", externalSessionId: "thr_1" })).toThrow()
})

it("marks stale running rows interrupted at startup", () => {
  const repo = createTestRepository()
  repo.create({ id: "c1", externalSessionId: "thr_1" })
  repo.setStatus("c1", "running")
  expect(repo.interruptRunning()).toBe(1)
  expect(repo.getById("c1")?.status).toBe("interrupted")
})
```

- [ ] **Step 2: Run the tests and confirm Red**

Run: `pnpm vitest run src/shared/contracts.test.ts src/server/database.test.ts src/server/conversation-repository.test.ts`

Expected: FAIL because contracts and repository are missing.

- [ ] **Step 3: Define the shared types and runtime decision guard**

Use discriminated unions matching the approved spec. Add
`isApprovalDecision(value): value is "accept" | "decline"` and test that every other string is rejected.
Browser-facing `ConversationSummary` and `ConversationDetail` must not contain
`externalSessionId` or `codexThreadId`; those identifiers remain server-only.

- [ ] **Step 4: Implement the versioned SQLite migration**

Use `DatabaseSync` from `node:sqlite`, enable `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`, and create:

```sql
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  codex_thread_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle','running','failed','interrupted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 5: Implement parameterized repository operations**

Use prepared statements only. `create` assigns `新会话`, `idle`, and ISO timestamps. `list` orders by `updated_at DESC`. Missing IDs return `null`; repository methods never accept raw SQL fragments.

- [ ] **Step 6: Run database verification**

Run: `pnpm vitest run src/shared/contracts.test.ts src/server/database.test.ts src/server/conversation-repository.test.ts`

Expected: PASS, including duplicate external ID, migration idempotency, ordering, and interrupted recovery.

- [ ] **Step 7: Commit**

```bash
git add src/shared src/server/database* src/server/conversation-repository*
git commit -m "feat: persist TaskMux conversation metadata"
```

---

### Task 3: Codex JSON-RPC process client

**Files:**
- Create: `src/server/codex/codex-types.ts`
- Create: `src/server/codex/json-rpc-client.ts`
- Create: `src/server/codex/json-rpc-client.test.ts`
- Create: `tests/fixtures/fake-app-server.mjs`

**Interfaces:**
- Produces: `CodexProcessOptions = { command: string; args: string[]; cwd: string }`
- Produces: `CodexJsonRpcClient.start`, `.request<T>`, `.respond`, `.subscribe`, `.stop`
- Emits: `{ type: "notification" | "server_request" | "exit" | "protocol_error"; ... }`

- [ ] **Step 1: Create a failing handshake/request-correlation test**

```ts
const client = new CodexJsonRpcClient(fakeProcessOptions(workspace))
await client.start({ name: "taskmux", title: "TaskMux", version: "0.1.0" })
const first = await client.request("thread/start", { cwd: workspace })
const second = await client.request("thread/start", { cwd: workspace })
expect(first.thread.id).not.toBe(second.thread.id)
await client.stop()
```

Also test split JSON chunks, malformed lines, stderr capture, request timeout, server-initiated request delivery, and unexpected process exit rejecting pending promises.

- [ ] **Step 2: Run the client tests and confirm Red**

Run: `pnpm vitest run src/server/codex/json-rpc-client.test.ts`

Expected: FAIL because the client and fixture are missing.

- [ ] **Step 3: Implement the deterministic Fake App Server**

The fixture reads stdin with `readline`. It must reject methods before `initialize`, reply to `initialize`, accept `initialized`, assign `thr_1`, `thr_2`, and retain in-memory turns. Prompt markers drive deterministic behavior:

```text
hello       → two item/agentMessage/delta notifications, then turn/completed
[tool]      → commandExecution item started/completed plus text
[approval]  → server request item/commandExecution/requestApproval
[file]      → server request item/fileChange/requestApproval
[crash]     → process.exit(17)
```

- [ ] **Step 4: Implement the client without shell interpolation**

Use `spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] })`. Buffer stdout until newline, parse each non-empty line, correlate response `id`, and surface notifications and server requests. `start` sends `initialize`, verifies its response, then sends `initialized`. Default request timeout is 15 seconds. `stop` is idempotent and rejects unresolved requests with `app_server_stopped`.

- [ ] **Step 5: Run protocol verification**

Run: `pnpm vitest run src/server/codex/json-rpc-client.test.ts`

Expected: all handshake, chunking, timeout, malformed-message, stderr, and exit tests pass without a real Codex installation.

- [ ] **Step 6: Commit**

```bash
git add src/server/codex tests/fixtures/fake-app-server.mjs
git commit -m "feat: add Codex app-server JSON-RPC client"
```

---

### Task 4: Provider-neutral AgentAdapter and Codex normalization

**Files:**
- Create: `src/server/agent/agent-adapter.ts`
- Create: `src/server/codex/codex-adapter.ts`
- Create: `src/server/codex/codex-adapter.test.ts`

**Interfaces:**
- Produces: `AgentAdapter` exactly as defined in the design spec
- Produces: `AgentAdapterEvent = { externalSessionId: string; payload: ConversationEvent }`
- Consumes: `CodexJsonRpcClient`

- [ ] **Step 1: Write failing normalization tests**

```ts
it("normalizes streamed text and compact command status", async () => {
  fake.emit(agentDelta("thr_1", "turn_1", "hel"))
  fake.emit(agentDelta("thr_1", "turn_1", "lo"))
  fake.emit(commandStarted("thr_1", "turn_1", "item_1", "pnpm test"))
  fake.emit(commandCompleted("thr_1", "turn_1", "item_1"))
  expect(events).toEqual([
    event("thr_1", { type: "text_delta", turnId: "turn_1", text: "hel" }),
    event("thr_1", { type: "text_delta", turnId: "turn_1", text: "lo" }),
    event("thr_1", { type: "tool_status", tool: { id: "item_1", label: "运行命令", status: "running" } }),
    event("thr_1", { type: "tool_status", tool: { id: "item_1", label: "运行命令", status: "completed" } }),
  ])
})
```

Cover user/assistant history projection, failed/declined tools, `turn/completed`, interrupt, command approval, file approval, and unknown server request rejection.

- [ ] **Step 2: Run adapter tests and confirm Red**

Run: `pnpm vitest run src/server/codex/codex-adapter.test.ts`

Expected: FAIL because no adapter exists.

- [ ] **Step 3: Define the generic interface and private Codex wire types**

Keep `CodexThread`, `CodexTurn`, and item unions inside `src/server/codex`. Shared and client modules may import only types from `src/shared/contracts.ts`.

- [ ] **Step 4: Implement the stable App Server method mapping**

Map `createSession` to `thread/start({ cwd, serviceName: "taskmux" })`, `readSession` to `thread/read({ threadId, includeTurns: true })`, `resumeSession` to `thread/resume`, `sendText` to `turn/start` with one text input item, and `cancelTurn` to `turn/interrupt`. Do not enable `experimentalApi`.

- [ ] **Step 5: Implement tool and approval normalization**

Command and file-change items expose only `运行命令` or `修改文件` plus status. Store pending server-request IDs internally. `respondToApproval` resolves only a known pending request. Unknown server requests receive a safe decline/cancel response and emit `unsupported_interaction`.

- [ ] **Step 6: Run adapter verification**

Run: `pnpm vitest run src/server/codex/codex-adapter.test.ts && pnpm typecheck`

Expected: PASS and `rg "Codex" src/shared src/client` returns no provider-wire types.

- [ ] **Step 7: Commit**

```bash
git add src/server/agent src/server/codex src/shared/contracts.ts
git commit -m "feat: normalize Codex sessions behind AgentAdapter"
```

---

### Task 5: Conversation service, state machine, and recovery

**Files:**
- Create: `src/server/conversation-service.ts`
- Create: `src/server/conversation-service.test.ts`

**Interfaces:**
- Produces: `ConversationService.list`, `.create`, `.getDetail`, `.sendText`, `.cancel`, `.respondToApproval`, `.recoverStartup`, `.handleClientDisconnect`
- Consumes: `ConversationRepository`, `AgentAdapter`, and an event sink

- [ ] **Step 1: Write failing use-case and concurrency tests**

```ts
it("rejects a second global turn and releases the lock on completion", async () => {
  const a = await service.create()
  const b = await service.create()
  await service.sendText(a.id, "first")
  await expect(service.sendText(b.id, "second")).rejects.toMatchObject({ code: "turn_conflict" })
  adapter.emit(a.externalSessionId, { type: "turn_completed", turnId: "t1" })
  await expect(service.sendText(b.id, "second")).resolves.toBeUndefined()
})
```

Also cover blank and 100,001-code-point prompts, title generation, missing conversation IDs, cancel idempotency, failed send rollback, startup `running → interrupted`, process exit, and client disconnect interruption.

- [ ] **Step 2: Run service tests and confirm Red**

Run: `pnpm vitest run src/server/conversation-service.test.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement conversation creation and history reads**

Generate TaskMux IDs with `randomUUID`. Create the external session first, then persist its ID. For details, fetch the row, call `adapter.readSession`, and attach the TaskMux conversation ID.

- [ ] **Step 4: Implement the explicit active-turn state machine**

Use `Map<conversationId, { externalSessionId; turnId?: string }>` plus `activeConversationId: string | null`. Set the lock before awaiting `sendText`; on synchronous or asynchronous failure, completion, interruption, or adapter error, update SQLite and clear both ownership markers in `finally`-equivalent helpers.

- [ ] **Step 5: Implement titles, cancellation, approval, and recovery**

Generate a title only after the first send succeeds: collapse whitespace and take the first 60 Unicode code points. `cancel` succeeds when idle. `handleClientDisconnect` interrupts the sole active turn. `recoverStartup` calls `interruptRunning` before accepting requests.

- [ ] **Step 6: Run state-machine verification**

Run: `pnpm vitest run src/server/conversation-service.test.ts`

Expected: all lifecycle and adversarial concurrency cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/conversation-service.ts src/server/conversation-service.test.ts
git commit -m "feat: manage conversation lifecycle and turn locks"
```

---

### Task 6: Sequenced EventHub, REST API, and SSE transport

**Files:**
- Create: `src/server/event-hub.ts`
- Create: `src/server/event-hub.test.ts`
- Create: `src/server/http-routes.ts`
- Create: `src/server/http-routes.test.ts`
- Create: `src/server/app.ts`

**Interfaces:**
- Produces: `EventHub.publish(conversationId, payload)`, `.subscribe(handler)`, `.subscriberCount`
- Produces: `buildApp({ config, repository, adapter }): Promise<FastifyInstance>`
- Consumes: `ConversationService`

- [ ] **Step 1: Write failing EventHub and API tests**

```ts
it("adds monotonic sequence numbers", () => {
  hub.publish("c1", { type: "turn_started", turnId: "t1" })
  hub.publish("c1", { type: "text_delta", turnId: "t1", text: "x" })
  expect(received.map((event) => event.seq)).toEqual([1, 2])
})

it("returns 409 for a second send", async () => {
  const response = await app.inject({ method: "POST", url: "/api/conversations/c2/messages", payload: { text: "two" } })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe("turn_conflict")
})
```

Cover every route, invalid ID, invalid approval, fixed Workspace response, health degradation, SSE headers, unsubscribe, and disconnect-triggered interruption.

- [ ] **Step 2: Run transport tests and confirm Red**

Run: `pnpm vitest run src/server/event-hub.test.ts src/server/http-routes.test.ts`

Expected: FAIL because transport modules are missing.

- [ ] **Step 3: Implement EventHub**

Use one process-wide numeric sequence counter. Publish immutable envelopes. Catch one subscriber's exception without preventing other subscribers. Return an idempotent unsubscribe function.

- [ ] **Step 4: Implement REST routes with explicit validation**

Implement the approved endpoints. Accept JSON `{ text: string }` for messages and `{ decision: "accept" | "decline" }` for approvals. Map domain errors to stable HTTP codes: invalid input `400`, missing `404`, conflict `409`, unavailable Codex `503`, unexpected `500`.

- [ ] **Step 5: Implement SSE lifecycle**

Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`. Serialize each envelope as `id: <seq>\ndata: <json>\n\n`. When the only client disconnects, unsubscribe and call `handleClientDisconnect`.

- [ ] **Step 6: Run server verification**

Run: `pnpm vitest run src/server/event-hub.test.ts src/server/http-routes.test.ts && pnpm typecheck`

Expected: PASS with no open-handle warning.

- [ ] **Step 7: Commit**

```bash
git add src/server/event-hub* src/server/http-routes* src/server/app.ts
git commit -m "feat: expose conversation API and event stream"
```

---

### Task 7: React shell, conversation list, and completed history

**Files:**
- Create: `index.html`
- Create: `src/client/main.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/conversation-store.tsx`
- Create: `src/client/conversation-store.test.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/App.test.tsx`
- Create: `src/client/components/Sidebar.tsx`
- Create: `src/client/components/Thread.tsx`
- Create: `src/client/styles.css`

**Interfaces:**
- Produces: `TaskMuxApi` methods matching the REST endpoints
- Produces: `ConversationProvider` and `useConversations()`
- Consumes: shared DTOs only

- [ ] **Step 1: Write failing list, create, switch, and history tests**

```tsx
render(<App api={fakeApi} />)
expect(await screen.findByText("修复 README 测试")).toBeVisible()
await user.click(screen.getByRole("button", { name: "新建会话" }))
expect(fakeApi.createConversation).toHaveBeenCalledOnce()
await user.click(screen.getByRole("button", { name: "第二个会话" }))
expect(await screen.findByText("历史回答")).toBeVisible()
```

Cover loading, empty list, unavailable history, selected-row state, and message ordering.

- [ ] **Step 2: Run component tests and confirm Red**

Run: `pnpm vitest run src/client/conversation-store.test.tsx src/client/App.test.tsx`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the typed API client and reducer**

Every non-2xx response becomes `TaskMuxApiError { code, message, status }`. The reducer stores summaries by ID, ordered IDs, selected ID, detail by ID, loading state, and page-level error. It must ignore detail responses for a selection that changed while the request was in flight.

- [ ] **Step 4: Implement the accessible two-pane shell**

Use a fixed 280px sidebar on desktop and a stacked layout below 720px. Conversation entries are buttons with title, status, and `<time>`. The thread uses semantic `<main>` and message `<article>` elements with `white-space: pre-wrap`; do not render Markdown or HTML.

- [ ] **Step 5: Run UI verification**

Run: `pnpm vitest run src/client/conversation-store.test.tsx src/client/App.test.tsx`

Expected: PASS for loading, empty, create, switch, stale response, error, and history cases.

- [ ] **Step 6: Commit**

```bash
git add index.html src/client
git commit -m "feat: render TaskMux conversation workspace"
```

---

### Task 8: Live streaming, composer, compact tools, approvals, and cancellation

**Files:**
- Create: `src/client/use-event-stream.ts`
- Create: `src/client/use-event-stream.test.tsx`
- Create: `src/client/components/Composer.tsx`
- Create: `src/client/components/Composer.test.tsx`
- Create: `src/client/components/ToolLine.tsx`
- Create: `src/client/components/ToolLine.test.tsx`
- Create: `src/client/components/ApprovalBar.tsx`
- Create: `src/client/components/ApprovalBar.test.tsx`
- Modify: `src/client/conversation-store.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/Thread.tsx`

**Interfaces:**
- Produces: `useEventStream(dispatch): EventStreamState`
- Adds reducer actions: `eventReceived`, `sendOptimistic`, `sendRejected`, `approvalResolved`
- Consumes: `ConversationEventEnvelope`

- [ ] **Step 1: Write failing live-state tests**

```ts
state = reduce(state, event(textDelta("c1", "t1", "hel")))
state = reduce(state, event(textDelta("c1", "t1", "lo")))
expect(selectLiveText(state, "c1", "t1")).toBe("hello")

state = reduce(state, event(toolStatus("c1", "tool1", "running")))
state = reduce(state, event(toolStatus("c1", "tool1", "completed")))
expect(selectTools(state, "c1")).toHaveLength(1)
expect(selectTools(state, "c1")[0].status).toBe("completed")
```

Cover duplicate `seq`, events for unselected conversations, Turn completion, interruption, approval expiry, send conflict, reconnect indicator, and cancel.

- [ ] **Step 2: Run live UI tests and confirm Red**

Run: `pnpm vitest run src/client/use-event-stream.test.tsx src/client/components/Composer.test.tsx src/client/components/ToolLine.test.tsx src/client/components/ApprovalBar.test.tsx`

Expected: FAIL because live components are missing.

- [ ] **Step 3: Implement SSE subscription and reducer merging**

Create one `EventSource("/api/events")`. Track the largest accepted `seq` and ignore duplicate or older envelopes. Append deltas by `turnId`; update tools by tool ID; on completion move live assistant text into the displayed completed turn until the next history reload.

- [ ] **Step 4: Implement Composer behavior**

Use a plain `<textarea>`. Enter sends, Shift+Enter inserts a newline. Disable send when empty, above 100,000 code points, or any conversation is running. Show Cancel only while active. Preserve draft text when sending fails with `409` or a transport error.

- [ ] **Step 5: Implement compact tool and approval UI**

`ToolLine` renders only icon, localized category label, and state. `ApprovalBar` shows `Codex 请求运行命令` or `Codex 请求修改文件` with `批准` and `拒绝`; it never displays command, output, path, or Diff. Disable both buttons after the first click.

- [ ] **Step 6: Run client verification**

Run: `pnpm vitest run src/client && pnpm typecheck`

Expected: PASS for streaming, deduplication, tool replacement, approvals, cancel, drafts, and accessibility queries.

- [ ] **Step 7: Commit**

```bash
git add src/client src/shared/contracts.ts
git commit -m "feat: add live text turns and minimal approvals"
```

---

### Task 9: Application bootstrap, Codex diagnostics, and failure recovery

**Files:**
- Create: `src/server/main.ts`
- Create: `src/server/main.test.ts`
- Create: `src/server/codex/codex-diagnostics.ts`
- Create: `src/server/codex/codex-diagnostics.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/codex/json-rpc-client.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Produces: `diagnoseCodex(command): Promise<CodexDiagnostic>`
- Produces: `startTaskMux(config, dependencies?): Promise<RunningTaskMux>`
- `CodexDiagnostic` codes match `codex_not_found`, `codex_version_unsupported`, and `codex_not_authenticated`

- [ ] **Step 1: Write failing startup and restart tests**

```ts
it("restarts app-server once and releases the active turn", async () => {
  const running = await startHarness({ crashOnFirstTurn: true })
  await running.service.sendText(running.conversation.id, "[crash]")
  await eventually(() => expect(running.spawnCount()).toBe(2))
  expect(running.repository.getById(running.conversation.id)?.status).toBe("failed")
  await expect(running.service.sendText(running.conversation.id, "hello")).resolves.toBeUndefined()
})
```

Cover missing command, unsupported `app-server --help`, handshake authentication failure, second crash stopping retries, stale-running startup recovery, SIGINT shutdown, and fixed loopback binding.

- [ ] **Step 2: Run startup tests and confirm Red**

Run: `pnpm vitest run src/server/main.test.ts src/server/codex/codex-diagnostics.test.ts`

Expected: FAIL because bootstrap and diagnostics are missing.

- [ ] **Step 3: Implement preflight diagnostics**

Resolve `codex` from PATH without accepting a browser-provided override. Run `codex --version` and `codex app-server --help` with argument arrays and five-second timeouts. Classify spawn `ENOENT`, missing app-server command, and initialization authentication errors into stable codes without logging credentials or environment contents.

- [ ] **Step 4: Implement dependency composition and one restart**

Open/migrate the DB, interrupt stale rows, create EventHub, JSON-RPC client, adapter, repository, service, and Fastify app in that order. On unexpected process exit, fail the active Turn, restart exactly once, redo initialization, and reset the retry budget only after a later successful Turn.

- [ ] **Step 5: Serve Vite in development and static output in production**

In development, dynamically import Vite with `middlewareMode: true` and attach its middleware after API routes. In production, use `@fastify/static` for `dist/client` and return `index.html` for non-API navigation. Listen only on `config.host`.

- [ ] **Step 6: Implement graceful shutdown and user-visible diagnostics**

SIGINT/SIGTERM closes HTTP, interrupts an active Turn, stops App Server, closes SQLite, and exits once. The React shell renders each stable error code with one concrete action, such as install/login/restart, without exposing stderr by default.

- [ ] **Step 7: Run application verification**

Run: `pnpm vitest run src/server/main.test.ts src/server/codex/codex-diagnostics.test.ts && pnpm build && pnpm typecheck`

Expected: PASS, a successful production build, and no server binding other than loopback.

- [ ] **Step 8: Commit**

```bash
git add src/server src/client/App.tsx src/client/styles.css
git commit -m "feat: bootstrap and supervise the TaskMux runtime"
```

---

### Task 10: Browser acceptance, real-Codex smoke test, and operator documentation

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/server.ts`
- Create: `tests/e2e/workbench.spec.ts`
- Create: `scripts/smoke-real-codex.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: the production HTTP API, SSE protocol, and Fake App Server process
- Produces: repeatable V1 acceptance evidence and an opt-in real-Codex check

- [ ] **Step 1: Write the failing browser journey**

```ts
test("creates, streams, approves, refreshes, and resumes conversations", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "新建会话" }).click()
  await page.getByRole("textbox").fill("[tool] hello")
  await page.getByRole("button", { name: "发送" }).click()
  await expect(page.getByText("运行命令：完成")).toBeVisible()
  await expect(page.getByText("hello")).toBeVisible()
  await page.reload()
  await expect(page.getByText("hello")).toBeVisible()
})
```

Add cases for two-conversation switching, `[approval]`, decline, double-send conflict, cancel, `[crash]`, second-crash manual recovery, and service restart with the same temporary database.

- [ ] **Step 2: Run Playwright and confirm Red**

Run: `pnpm test:e2e`

Expected: FAIL because the E2E server harness does not exist.

- [ ] **Step 3: Implement the isolated E2E server harness**

Create temporary Workspace and data directories with `mkdtemp`. Start the real application using the real JSON-RPC client configured to spawn `process.execPath tests/fixtures/fake-app-server.mjs`. Never reference the operator's home Codex store. Reuse the temporary DB only in the restart test.

- [ ] **Step 4: Implement the opt-in real Codex smoke script**

Require `TASKMUX_SMOKE_WORKSPACE` to name an existing disposable directory. Start App Server, create one Thread, send `Reply with exactly TASKMUX_SMOKE_OK and do not use tools.`, assert the completed text contains `TASKMUX_SMOKE_OK`, then stop. Do not run this script in CI or during normal `pnpm test`.

- [ ] **Step 5: Write operator documentation**

Document prerequisites, `pnpm install`, `pnpm dev -- --workspace /absolute/path`, production build/start, data location, test commands, real smoke opt-in, security boundary, V1 limitations, and the explicit choice to defer ACP until a second Agent is added.

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Expected: every command exits 0. Then, only with an explicitly disposable Workspace and working Codex login, run `TASKMUX_SMOKE_WORKSPACE=/absolute/disposable/path pnpm smoke:codex` and expect `TASKMUX_SMOKE_OK`.

- [ ] **Step 7: Confirm repository hygiene**

Run: `git status --short` and verify no SQLite database, Codex transcript, temporary Workspace, browser artifact, `.superpowers/`, or unrelated pre-existing file is staged.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.ts tests/e2e scripts/smoke-real-codex.ts README.md
git commit -m "test: verify TaskMux v1 end to end"
```

## Final Release Gate

- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` from a clean process state.
- [ ] Confirm all thirteen acceptance criteria in the design spec map to passing automated tests or the documented opt-in smoke test.
- [ ] Confirm `rg -n "codex|CodexJsonRpc" src/client src/shared` finds only user-facing product copy, never wire types or App Server method names.
- [ ] Confirm only TaskMux-created external session IDs are addressable through HTTP.
- [ ] Confirm the server listens only on `127.0.0.1` and Workspace is immutable after startup.
- [ ] Confirm the worktree contains no staged pre-existing or generated personal files.
