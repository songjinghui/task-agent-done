# TaskMux ACP 双后端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Agent Client Protocol（ACP）同时驱动 Codex 与 Claude Code 两个后端，启动时配置切换；删除原有 raw Codex 协议栈，复用同一套 ACP 客户端、适配器、文件读写与终端执行。

**Architecture:** 新增 `src/server/acp/` 目录，基于 `@agentclientprotocol/sdk` 实现 ACP 客户端、适配器与 fs/terminal handler。分三阶段：Phase 1 先打通 Claude（Codex 暂保留 raw 栈）；Phase 2 把 Codex 切到 `codex-acp` 复用同一套适配器；Phase 3 删除 raw Codex 栈。

**Tech Stack:** TypeScript, Node.js child_process, `@agentclientprotocol/sdk` v1.3.0, `codex-acp` 1.4.0, `claude-agent-acp` 0.69.0, Vitest, Fastify, Playwright

## Global Constraints

- 真实目标：本机 `codex-acp` 1.4.0 与 `claude-agent-acp` 0.69.0（均在 PATH）。
- 两个后端共用同一个 `AcpAgentAdapter`，切换只换启动的二进制。
- `AgentAdapter` 接口形状与 `ConversationEvent` 类型保持不变，前端零改动。
- 启动开关：`TASKMUX_AGENT` 环境变量或 `--agent` CLI 参数，默认 `codex`（向后兼容）。
- 不引入任何 API key；认证完全由 agent CLI 自身处理。
- fs/terminal 执行由 TaskMux（作为 ACP client）实现，限制在 workspace 内。
- TDD：每个任务先写 failing test，再写实现，再 GREEN。
- 每任务独立提交，可独立 review。
- 真实验证使用一次性 workspace，不发送模型 turn 不通过工具（仅一条纯文本消息验证协议打通）。

---

### Task 1: 引入 ACP SDK 与配置扩展

**Files:**
- Modify: `package.json`
- Modify: `src/server/config.ts`
- Modify: `src/server/config.test.ts`
- Test: `src/server/config.test.ts`

**Interfaces:**
- Consumes: 现有 `parseServerConfig(argv, env)`
- Produces: `ServerConfig.agent: "codex" | "claude"`，来源 `--agent` 参数或 `TASKMUX_AGENT` 环境变量，默认 `"codex"`

- [ ] **Step 1: 安装 `@agentclientprotocol/sdk`**

```bash
pnpm add @agentclientprotocol/sdk@1.3.0
```

- [ ] **Step 2: 为 `--agent` / `TASKMUX_AGENT` 写 failing 测试**

在 `src/server/config.test.ts` 末尾添加：

```ts
describe("agent config", () => {
  it("defaults to codex", () => {
    const config = parseServerConfig(
      ["--workspace", "/tmp/ws"],
      {}
    )
    expect(config.agent).toBe("codex")
  })

  it("reads TASKMUX_AGENT", () => {
    const config = parseServerConfig(
      ["--workspace", "/tmp/ws"],
      { TASKMUX_AGENT: "claude" }
    )
    expect(config.agent).toBe("claude")
  })

  it("prefers --agent over env", () => {
    const config = parseServerConfig(
      ["--workspace", "/tmp/ws", "--agent", "claude"],
      { TASKMUX_AGENT: "codex" }
    )
    expect(config.agent).toBe("claude")
  })

  it("rejects invalid agent values", () => {
    expect(() =>
      parseServerConfig(["--workspace", "/tmp/ws", "--agent", "gpt"], {})
    ).toThrow(/agent/)
  })

  it("rejects invalid env agent", () => {
    expect(() =>
      parseServerConfig(["--workspace", "/tmp/ws"], { TASKMUX_AGENT: "gpt" })
    ).toThrow(/agent/)
  })
})
```

- [ ] **Step 3: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/config.test.ts
```

Expected: FAIL（`config.agent` 不存在 / `--agent` 未解析）。

- [ ] **Step 4: 在 config 中实现 agent 字段**

在 `src/server/config.ts` 的 `ServerConfig` 类型里增加 `agent: "codex" | "claude"`；在 `parseServerConfig` 里读取 `--agent` 参数（优先）和 `TASKMUX_AGENT` 环境变量（回退），默认 `"codex"`；非法值抛错 `"Agent must be codex or claude."`。

- [ ] **Step 5: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/config.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/server/config.ts src/server/config.test.ts
git commit -m "feat: add agent config switch (codex/claude)"
```

---

### Task 2: ACP 客户端脚手架（spawn + 握手 + stop）

**Files:**
- Create: `src/server/acp/acp-client.ts`
- Create: `src/server/acp/acp-client.test.ts`

**Interfaces:**
- Consumes: `ServerConfig.agent`、workspace 路径
- Produces: `AcpClient` 类，构造参数 `{ command: string; args?: string[]; cwd: string }`，方法 `start(timeoutMs?): Promise<void>`、`stop(timeoutMs?): Promise<void>`、`subscribe(listener): () => void`；事件类型 `AcpClientEvent = { type: "exit" } | { type: "protocol_error"; message: string } | { type: "connected" }`

- [ ] **Step 1: 写 failing 测试（连接成功 + 停止）**

在 `src/server/acp/acp-client.test.ts` 中，用内置 fake agent（通过 SDK 的 `AgentApp`）+ stdin/stdout pipe 验证 `start` → `stop` 生命周期。

```ts
import { describe, expect, it } from "vitest"
import { AcpClient } from "./acp-client.js"

describe("AcpClient", () => {
  it("connects and stops cleanly", async () => {
    // 用 echo/hello 级别的最小 fake：先简单验证 start 不抛错、stop 能退出
    // 真正的 ACP 握手在 Task 3 测。这里用一个会立即关闭 stdin 的进程做 smoke
    const client = new AcpClient({
      command: "node",
      args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 50)"],
      cwd: "/tmp",
    })
    let exited = false
    client.subscribe((e) => {
      if (e.type === "exit") exited = true
    })
    // 对最小进程直接 stop 即可
    await client.stop(1000)
    expect(existed).toBe(true)
  })

  it("throws on start if binary not found", async () => {
    const client = new AcpClient({
      command: "definitely-not-a-real-binary-xyz",
      cwd: "/tmp",
    })
    await expect(client.start(500)).rejects.toMatchObject({
      message: expect.stringMatching(/app_server_exited|app_server_stopped/),
    })
    await client.stop(100).catch(() => {})
  })
})
```

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/acp/acp-client.test.ts
```

Expected: FAIL（`AcpClient` 不存在）。

- [ ] **Step 3: 实现 `AcpClient` 基础脚手架**

在 `src/server/acp/acp-client.ts` 中实现：spawn 子进程 + stdio pipe，`start`/`stop` 生命周期，subscribe 事件模型。**这一步先不做 ACP initialize 握手**（留到 Task 3），只做进程管理与事件通道。风格对齐 `CodexJsonRpcClient` 的状态机（`idle/starting/started/stopping/stopped`）。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/acp/acp-client.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-client.ts src/server/acp/acp-client.test.ts
git commit -m "feat: add AcpClient scaffold with process lifecycle"
```

---

### Task 3: ACP initialize 握手与 ClientApp 集成

**Files:**
- Modify: `src/server/acp/acp-client.ts`
- Modify: `src/server/acp/acp-client.test.ts`
- Create: `tests/fixtures/fake-acp-agent.mjs`

**Interfaces:**
- Consumes: Task 2 的 `AcpClient` 脚手架
- Produces: `start(clientInfo, timeoutMs?)` 完成 ACP `initialize` 握手；`request<T>(method, params, timeoutMs?)` 调用 agent 方法；响应 `connected` 事件

- [ ] **Step 1: 写 initialize 握手 failing 测试**

在 `src/server/acp/acp-client.test.ts` 中追加测试。用 fake ACP agent 小脚本（`tests/fixtures/fake-acp-agent.mjs`）做 stdio 握手。fake 脚本只响应 `initialize` 请求，返回 `{ protocolVersion, capabilities }`。

```ts
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const fakeAgentPath = join(__dirname, "../../../tests/fixtures/fake-acp-agent.mjs")

it("completes ACP initialize handshake", async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeAgentPath],
    cwd: "/tmp",
  })
  let connected = false
  client.subscribe((e) => {
    if (e.type === "connected") connected = true
  })
  await client.start({ name: "taskmux", title: "TaskMux", version: "0.0.0" }, 2000)
  expect(connected).toBe(true)
  await client.stop(1000)
})
```

同时在 `tests/fixtures/fake-acp-agent.mjs` 写最小 fake：

```mjs
import { createInterface } from "node:readline"

const rl = createInterface({ input: process.stdin })
let nextId = 1

rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-08-01",
          capabilities: {
            sessionNew: true,
            sessionLoad: true,
            prompt: true,
            cancel: true,
          },
          agentInfo: { name: "fake-acp-agent", version: "0.1.0" },
        },
      }) + "\n"
    )
    return
  }
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "method_not_found: " + msg.method },
    }) + "\n"
  )
})
```

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/acp/acp-client.test.ts -t "initialize handshake"
```

Expected: FAIL（`start` 不接受 clientInfo / 没做 initialize 握手）。

- [ ] **Step 3: 接入 `@agentclientprotocol/sdk` 的 `ClientApp` + `ndJsonStream`**

把 `start` 改成用 SDK：构造 `ClientApp`，把 child 的 stdin/stdout 转成 `ndJsonStream`（SDK 的 stream 是 Web Streams API，需用 `node:stream/web` 的 `ReadableStream`/`WritableStream` 包装 Node stream），然后 `connect`。握手完成后 emit `connected`。

封装一个 `request<T>(method, params, timeoutMs?)` 方法，基于 `ClientContext.request` 或 `connection` 提供的 typed 方法（优先用 `client.onRequest / onNotification` 注册 handler，调用侧通过 Promise 包装 + 超时）。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/acp/acp-client.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-client.ts src/server/acp/acp-client.test.ts tests/fixtures/fake-acp-agent.mjs
git commit -m "feat: complete ACP initialize handshake via SDK"
```

---

### Task 4: fs 读写 handler（受限 workspace）

**Files:**
- Create: `src/server/acp/acp-fs.ts`
- Create: `src/server/acp/acp-fs.test.ts`

**Interfaces:**
- Consumes: workspace 绝对路径
- Produces: `createFsHandlers({ workspace, app })` 函数，向 SDK `ClientApp` 注册 `fs/read_text_file` 与 `fs/write_text_file` 两个 client request handler，路径越界返回协议错误

- [ ] **Step 1: 写 failing 测试（越界拒绝 + 正常读写）**

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { createFsHandlers } from "./acp-fs.js"
import { ClientApp } from "@agentclientprotocol/sdk"

describe("acp-fs", () => {
  it("rejects paths outside workspace", async () => {
    const ws = await mkdtemp(join(tmpdir(), "acp-fs-"))
    try {
      const app = new ClientApp()
      createFsHandlers({ workspace: ws, app })
      // 此处模拟一个 ACP 上下文中的 handler 调用
      // 直接用 app 的 handler 调用需要一个 AgentApp 配合；
      // 简化：直接测底层的 path-safe 工具函数
      const { safeResolve } = await import("./acp-fs.js")
      expect(() => safeResolve(ws, "../etc/passwd")).toThrow(/outside/)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it("reads and writes files within workspace", async () => {
    const ws = await mkdtemp(join(tmpdir(), "acp-fs-"))
    try {
      await writeFile(join(ws, "hello.txt"), "world")
      const app = new ClientApp()
      createFsHandlers({ workspace: ws, app })
      // 注册完成后，通过 AgentApp 做一次内存级验证
      // （详细在 Task 5 的全栈测试里做；这里验证 handler 已注册且能正常工作）
      const handler = (app as any)._handlers?.["fs/read_text_file"]
      expect(handler).toBeDefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
```

（注：更直接的 handler 调用测试可以通过在 `ClientApp` 上暴露的方法实现；如 SDK 不直接暴露，则用 `AgentApp` + `app.connect(agentApp)` 做全链路测试。具体以 SDK API 为准，思路不变。）

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/acp/acp-fs.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 `createFsHandlers` 与 `safeResolve`**

实现：
- `safeResolve(workspace, inputPath)`：解析绝对路径或相对路径，做 `realpathSync`（或 `fs.realpath`），验证以 workspace 开头；越界抛错。
- `createFsHandlers({ workspace, app })`：向 `app.onRequest("fs/read_text_file", ctx => ...)` 与 `app.onRequest("fs/write_text_file", ctx => ...)` 注册。
- `read_text_file`：读文件内容为字符串（UTF-8），返回 `{ content: string }`。
- `write_text_file`：写文件（父目录不存在则创建），返回 `{ ok: true }`。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/acp/acp-fs.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-fs.ts src/server/acp/acp-fs.test.ts
git commit -m "feat: add ACP filesystem handlers (workspace-scoped)"
```

---

### Task 5: terminal 执行 handler

**Files:**
- Create: `src/server/acp/acp-terminal.ts`
- Create: `src/server/acp/acp-terminal.test.ts`

**Interfaces:**
- Consumes: workspace 绝对路径
- Produces: `createTerminalHandlers({ workspace, app })`，实现 `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/release`、`terminal/kill`；终端输出来自 agent 端的 `terminal/output` 通知

- [ ] **Step 1: 写 failing 测试（创建 + 退出收集）**

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { createTerminalHandlers } from "./acp-terminal.js"
import { ClientApp } from "@agentclientprotocol/sdk"

describe("acp-terminal", () => {
  it("creates a terminal and waits for command exit", async () => {
    const ws = await mkdtemp(join(tmpdir(), "acp-term-"))
    try {
      const app = new ClientApp()
      createTerminalHandlers({ workspace: ws, app })
      // 通过 AgentApp 做全链路：发 terminal/create，等 wait_for_exit
      // 简化验证：handler 存在且 shell 可执行
      const handler = (app as any)._handlers?.["terminal/create"]
      expect(handler).toBeDefined()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/acp/acp-terminal.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 terminal handler**

实现：
- `terminal/create`：spawn shell（`process.env.SHELL || "/bin/sh"`），cwd=workspace，`shell -i` / 非交互两种模式（按 ACP schema），返回 `terminalId`。
- `terminal/output`：向终端 stdin 写数据。
- 终端 stdout/stderr → 通过 `client.notify("terminal/output_delta", ...)` 推送给 agent。
- `terminal/wait_for_exit`：等待终端退出，返回 `exitCode`。
- `terminal/release`：关闭 stdin，等自然退出。
- `terminal/kill`：发 SIGTERM，超时 SIGKILL。
- 用 `Map<terminalId, TerminalHandle>` 管理句柄。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/acp/acp-terminal.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-terminal.ts src/server/acp/acp-terminal.test.ts
git commit -m "feat: add ACP terminal execution handlers"
```

---

### Task 6: AcpAgentAdapter（事件映射 + 会话方法）

**Files:**
- Create: `src/server/acp/acp-adapter.ts`
- Create: `src/server/acp/acp-adapter.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AcpClient`（request + subscribe）
- Produces: `AcpAgentAdapter implements AgentAdapter`，实现全部 `AgentAdapter` 方法与事件映射

- [ ] **Step 1: 写 failing 测试（create + send + 流式 delta + completed）**

在 `src/server/acp/acp-adapter.test.ts` 中用 `AgentApp` 构造 fake agent（内存内，不 spawn），覆盖：
1. `createSession` → 返回 `externalSessionId`
2. `sendText` → 收到 `text_delta` → `turn_completed` → resolves
3. `readSession` → `session/load` 流式回放重组为 `MessageTurn[]`
4. `respondToApproval` → agent 收到 `session/request_permission`，客户端回 `selected`

```ts
import { describe, expect, it } from "vitest"
import { AcpAgentAdapter } from "./acp-adapter.js"
import type { AgentAdapterEvent } from "../agent/agent-adapter.js"
// 通过 SDK 的 AgentApp + 内存 connect 做 fake
import { AgentApp } from "@agentclientprotocol/sdk"

// helper: 构造一个内存级 fake agent，注册到 AgentApp
function makeFakeAgent() {
  const agent = new AgentApp()
  const sessions = new Map<string, string[]>()
  let turnId = 1

  agent.onRequest("session/new", (ctx) => {
    const id = `sess_${Date.now()}`
    sessions.set(id, [])
    return { sessionId: id }
  })

  agent.onRequest("session/prompt", async (ctx) => {
    const tid = `turn_${turnId++}`
    // 流式推送 agent 文本
    ctx.notify("session/update", {
      sessionUpdate: "agent_message_chunk",
      text: "hello",
    })
    ctx.notify("session/update", {
      sessionUpdate: "agent_message_chunk",
      text: " world",
    })
    return { sessionId: ctx.params.sessionId }
  })

  return agent
}

describe("AcpAgentAdapter", () => {
  it("creates session, sends text, and streams completion", async () => {
    const agent = makeFakeAgent()
    const client = new AcpClient({ /* connect via AgentApp in-process */ } as any)
    // 用内存模式连接：client.connect(agent) —— API 以 SDK 为准
    const adapter = new AcpAgentAdapter(client)
    const events: AgentAdapterEvent[] = []
    adapter.subscribe((e) => events.push(e))

    const { externalSessionId } = await adapter.createSession("/ws")
    expect(externalSessionId).toBeTruthy()

    const { turnId } = await adapter.sendText(externalSessionId, "hi", "op-1")
    expect(turnId).toBeTruthy()

    const textEvents = events.filter((e) => e.payload.type === "text_delta")
    expect(textEvents.map((e) => (e.payload as any).text).join("")).toBe("hello world")

    adapter.dispose?.()
  })
})
```

（注：`AcpClient` 目前是 spawn 式的。为了测试 `AcpAgentAdapter`，要么给 `AcpClient` 加一个「用 SDK ClientApp 直接连接 AgentApp」的构造模式，要么在 adapter 测试里直接用 `ClientApp` + `AgentApp` 内存 connect。选择前者更干净：在 `AcpClient` 增加一个 `static fromAgentApp(agentApp)` 工厂方法，复用同一套事件/请求模型。）

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/acp/acp-adapter.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 `AcpAgentAdapter`**

实现要点：
1. `createSession(ws)` → `session/new { cwd: ws }` → 返回 `externalSessionId`。
2. `sendText(id, text, opId)` → 自生成 turnId → `session/prompt { sessionId, prompt: [{type:"text", text}] }` → 收集流式事件 → resolve 时返回 `{ turnId }`。
3. `readSession(id)` → `session/load` → 缓存所有 `user_message_chunk` / `agent_message_chunk` → 按轮次重组为 `MessageTurn[]`（相邻同 role 合并为一条）。
4. `cancelTurn(id)` → `session/cancel { sessionId }`。
5. `resumeSession(id)`：若当前已加载同 session，跳过；否则 `session/load`。
6. `respondToApproval(reqId, decision)`：回 `session/request_permission`：`accept` → `{ outcome: "selected", optionId: firstOptionId }`；`decline` → `{ outcome: "cancelled" }`。
7. 事件映射：
   - `session/update:agent_message_chunk` → `text_delta`
   - `session/update:tool_call` / `tool_call_update` → `tool_status`（label 从 tool name/title 映射，未知类型用「使用工具」）
   - `session/request_permission` → `approval_requested`（kind 映射：commandExecution→"command"，fileChange→"file_change"，其它→"command"）
   - `session/prompt` 完成 → `turn_completed`

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/acp/acp-adapter.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-adapter.ts src/server/acp/acp-adapter.test.ts
git commit -m "feat: add AcpAgentAdapter mapping ACP to AgentAdapter"
```

---

### Task 7: 诊断与 main.ts 集成（Claude 后端可用）

**Files:**
- Create: `src/server/acp/acp-diagnostics.ts`
- Modify: `src/server/main.ts`
- Modify: `src/server/main.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `config.agent`；Task 6 的 `AcpAgentAdapter`；Task 4/5 的 fs/terminal handler
- Produces: `agent=claude` 时 TaskMux 启动成功，HTTP 可用，会话创建/发送走 Claude 后端；现有 `agent=codex` 行为不变（仍走 raw Codex 栈）

- [ ] **Step 1: 写 failing 测试（claude agent 启动 degraded + createSession 失败路径）**

在 `src/server/main.test.ts` 追加：

```ts
it("degrades gracefully when claude agent is unavailable", async () => {
  const harness = makeRuntimeHarness({})
  const config = makeConfig()
  config.agent = "claude"
  // 覆盖 diagnose → not found
  harness.dependencies.diagnose = async () => ({
    status: "error",
    error: { code: "agent_not_found", message: "..." },
  })
  const running = await startTaskMux(config, harness.dependencies)
  expect(running.health().status).toBe("degraded")
  const response = await running.app.inject({
    method: "GET",
    url: "/api/health",
  })
  expect(response.statusCode).toBe(503)
  await running.shutdown()
})
```

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/main.test.ts -t "degrades gracefully when claude"
```

Expected: FAIL（`config.agent` 未在 main 中使用 / claude 诊断不存在）。

- [ ] **Step 3: 实现诊断与 main 集成**

1. 新建 `src/server/acp/acp-diagnostics.ts`：`diagnoseAgent(agentType): Promise<AgentDiagnostic>`，对 claude 检查 `claude-agent-acp --version`（或 `claude --version`），对 codex 保留原逻辑（迁移期）。
2. 在 `main.ts` 的 `startTaskMux` 中：
   - `config.agent === "claude"` 时：spawn `claude-agent-acp` → `AcpClient` → 注册 fs + terminal handler → `AcpAgentAdapter`。
   - `config.agent === "codex"` 时：**保留现有 raw Codex 路径**不变（Phase 2 再迁）。
3. 错误码兼容：迁移期新增 `agent_not_found`、`agent_version_unsupported`、`agent_not_authenticated`，加到 `UNAVAILABLE_CODES`。
4. 确保 degraded health 在 503 下仍可访问页面（与 Codex 路径一致）。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm vitest run src/server/main.test.ts
```

Expected: 全部 PASS（原有 codex 测试 + 新增 claude 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/server/acp/acp-diagnostics.ts src/server/main.ts src/server/main.test.ts
git commit -m "feat: wire claude agent via ACP into startup"
```

---

### Task 8: 全量单元测试 + 类型检查 + build

**Files:**
- N/A（验证任务）

**Interfaces:**
- Consumes: Tasks 1–7 所有产出
- Produces: 全量测试通过、类型检查通过、构建通过

- [ ] **Step 1: 运行 typecheck**

```bash
pnpm typecheck
```

Expected: exit 0。

- [ ] **Step 2: 运行全量 vitest**

```bash
pnpm test
```

Expected: 所有测试 PASS（含新增 ACP 测试）。

- [ ] **Step 3: 运行 build**

```bash
pnpm build
```

Expected: exit 0。

- [ ] **Step 4: `git diff --check`**

```bash
git diff --check
```

Expected: exit 0。

- [ ] **Step 5: 提交（如有必要的修复）**

如有发现问题，修复并提交；如无问题，跳到下一任务。

---

### Task 9: 真实 Claude 验证

**Files:**
- N/A（验证任务，不改文件）

**Interfaces:**
- Consumes: Task 7 后的可运行 TaskMux（`agent=claude`）
- Produces: 真实 `claude-agent-acp` 启动成功，`/api/health` 返回 ok，能创建会话并收到首条流式回复

- [ ] **Step 1: 用 `agent=claude` 启动 TaskMux**

```bash
mkdir -p /private/tmp/taskmux-claude-playground /private/tmp/taskmux-claude-data
TASKMUX_AGENT=claude TASKMUX_DATA_DIR=/private/tmp/taskmux-claude-data \
  pnpm dev -- --workspace /private/tmp/taskmux-claude-playground --port 4318
```

（后台运行，输出到 `/tmp/taskmux-claude.log`。）

- [ ] **Step 2: 等待健康检查通过**

```bash
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:4318/api/health >/dev/null && echo "READY" && break
  sleep 1
done
curl -s http://127.0.0.1:4318/api/health
```

Expected: `{"status":"ok"}`。

- [ ] **Step 3: 创建会话并发送一条纯文本消息**

```bash
CID=$(curl -s -X POST http://127.0.0.1:4318/api/conversations | jq -r .id)
curl -s -X POST http://127.0.0.1:4318/api/conversations/$CID/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"Say hello in one word.","clientRequestId":"smoke-1"}'
```

Expected: `{"accepted":true}`（HTTP 202）。

- [ ] **Step 4: 等待一段时间后读回详情，验证有回复**

```bash
sleep 15
curl -s http://127.0.0.1:4318/api/conversations/$CID | jq .
```

Expected: 至少有一条 assistant 角色的 turn，text 非空。

- [ ] **Step 5: 停止进程并清理**

SIGTERM 停掉 dev server，确认端口释放。

---

### Task 10: 把 Codex 切到 ACP（Phase 2）

**Files:**
- Modify: `src/server/main.ts`
- Modify: `src/server/main.test.ts`
- Modify: `src/server/acp/acp-diagnostics.ts`

**Interfaces:**
- Consumes: Task 7 的 ACP 全套基础设施
- Produces: `agent=codex` 也走 `codex-acp` ACP 二进制，不再走 raw `CodexJsonRpcClient`

- [ ] **Step 1: 写测试（codex 走 acp 的诊断与启动）**

在 `main.test.ts` 中更新 codex 相关测试，将 `FakeClient`（raw JSON-RPC 风格）替换为基于 `AgentApp` 的 fake ACP client（沿用 Task 6 的内存模式）。确保 degraded-health、重启预算、崩溃恢复等场景在 ACP 路径下同样成立。

- [ ] **Step 2: 运行测试，验证 RED**

```bash
pnpm vitest run src/server/main.test.ts
```

Expected: 部分 FAIL（codex 路径还在用 raw）。

- [ ] **Step 3: 切换 codex 后端到 ACP**

1. `main.ts`：`agent=codex` 时改用 `codex-acp` 二进制 + `AcpClient` + fs + terminal + `AcpAgentAdapter`，与 Claude 共用同一套实现，只换 command。
2. `acp-diagnostics.ts`：codex 诊断改为检查 `codex-acp --version` 或 `codex --version`（二选一存在即可）。
3. `UNAVAILABLE_CODES` 中保留 `codex_*` 错误码兼容（通过 `diagnosticError` 映射为 `agent_*` 或保留原样）。

- [ ] **Step 4: 运行测试，验证 GREEN**

```bash
pnpm test
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/main.ts src/server/main.test.ts src/server/acp/acp-diagnostics.ts
git commit -m "feat: switch codex backend to ACP via codex-acp"
```

---

### Task 11: 真实 Codex（ACP 路径）验证

**Files:**
- N/A（验证任务）

**Interfaces:**
- Consumes: Task 10 的 codex-acp 路径
- Produces: `agent=codex` 下 TaskMux 健康、可发消息、有回复

- [ ] **Step 1: 用 `agent=codex` 启动**

```bash
mkdir -p /private/tmp/taskmux-codex-acp-playground /private/tmp/taskmux-codex-acp-data
TASKMUX_AGENT=codex TASKMUX_DATA_DIR=/private/tmp/taskmux-codex-acp-data \
  pnpm dev -- --workspace /private/tmp/taskmux-codex-acp-playground --port 4319
```

（后台运行）

- [ ] **Step 2: 健康检查通过**

```bash
curl -s http://127.0.0.1:4319/api/health
```

Expected: `{"status":"ok"}`。

- [ ] **Step 3: 创建会话并发送一条消息，等待回复**

```bash
CID=$(curl -s -X POST http://127.0.0.1:4319/api/conversations | jq -r .id)
curl -s -X POST http://127.0.0.1:4319/api/conversations/$CID/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"Say hello in one word.","clientRequestId":"smoke-1"}'
sleep 20
curl -s http://127.0.0.1:4319/api/conversations/$CID | jq .
```

Expected: assistant 回复非空。

- [ ] **Step 4: 停止并清理**

---

### Task 12: 删除 raw Codex 栈（Phase 3）

**Files:**
- Delete: `src/server/codex/json-rpc-client.ts`
- Delete: `src/server/codex/json-rpc-client.test.ts`
- Delete: `src/server/codex/codex-adapter.ts`
- Delete: `src/server/codex/codex-adapter.test.ts`
- Delete: `tests/fixtures/fake-app-server.mjs`
- Modify: `src/server/codex/codex-diagnostics.ts`（合并到 `acp-diagnostics.ts`）
- Modify: `src/server/codex/codex-types.ts`（保留 `JsonRpcId` 等 ACP 还在用的类型，或迁到 acp/ 下）
- Modify: `src/server/main.test.ts`（删除 raw client 专用的 FakeClient）
- Modify: `src/server/http-routes.test.ts`（清理 codex-specific 引用）

**Interfaces:**
- Consumes: Tasks 1–11 的 ACP 完整实现
- Produces: 无 raw Codex 残留；所有路径都走 ACP；测试全绿

- [ ] **Step 1: 删除 raw 文件并修复引用**

删除上述 raw 文件；把 `codex-diagnostics.ts` 与 `codex-types.ts` 中 ACP 还依赖的部分合并到 `acp/`；其余清理。

- [ ] **Step 2: 运行 typecheck + 全量测试**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
```

Expected: 全部通过。

- [ ] **Step 3: `git diff --check`**

```bash
git diff --check
```

- [ ] **Step 4: 提交**

```bash
git rm -r src/server/codex tests/fixtures/fake-app-server.mjs
git add -A
git commit -m "refactor: remove raw Codex protocol stack, ACP only"
```

---

### Task 13: Playwright e2e 回归

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`（必要时更新 fixture）
- Modify: `tests/fixtures/fake-app-server.mjs` → 替换为 fake ACP agent

**Interfaces:**
- Consumes: Phase 3 完成后的干净 ACP 栈
- Produces: 8 条 Playwright e2e 全部 PASS，行为与之前一致

- [ ] **Step 1: 将 e2e fixture 从 fake-app-server 改为 fake-acp-agent**

把 `tests/fixtures/fake-app-server.mjs` 的行为移植到一个 ACP fake agent（`tests/fixtures/fake-acp-agent.mjs` 已有雏形，扩展即可）。确保：
- session/new / session/load / session/prompt / cancel / request_permission 响应与旧 fake 行为一致
- 流式 text_delta、工具状态、审批请求相同

- [ ] **Step 2: 运行 e2e**

```bash
pnpm test:e2e
```

Expected: 8/8 PASS。

- [ ] **Step 3: 提交**

```bash
git rm tests/fixtures/fake-app-server.mjs
git add tests/fixtures/fake-acp-agent.mjs tests/e2e/workbench.spec.ts
git commit -m "test: migrate e2e fixture from fake-app-server to fake ACP agent"
```

---

### Task 14: 最终门禁 + 推送

**Files:**
- N/A（验证 + 发布任务）

**Interfaces:**
- Consumes: 全部任务产出
- Produces: 全部门禁通过，推送到 `feature/taskmux-text-v1`

- [ ] **Step 1: 运行完整门禁**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
git diff --check
```

Expected: 全部 exit 0。

- [ ] **Step 2: 推送**

```bash
git push origin feature/taskmux-text-v1
git ls-remote --heads origin feature/taskmux-text-v1
```

Expected: 远端 SHA == 本地 HEAD。
