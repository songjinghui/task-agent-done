# TaskMux 双后端（Codex / Claude Code）ACP 接入设计

**状态：** 已批准，实施暂缓（等待用户指令）

**日期：** 2026-08-25

**产品：** TaskMux

**实施仓库：** 独立 `taskmux` 项目

## 1. 目标

TaskMux 当前只接入 Codex CLI 的私有 App Server 协议。本设计将 TaskMux
的协议层切换到 Agent Client Protocol（ACP），使其能够驱动两个后端：

- **Codex**：通过 `codex-acp`（ACP agent，内部驱动 Codex App Server）
- **Claude Code**：通过 `claude-agent-acp`（ACP agent，内部驱动 Claude Code CLI）

用户通过启动时配置选择其中一个后端，前端 UI 与内部抽象（`AgentAdapter`
接口）保持不变。两条后端共用同一套 ACP 客户端、适配器、文件读写与终端
执行实现。

## 2. 已确认的决策

1. 接入方式采用 **ACP 标准协议**（`@agentclientprotocol/sdk`），不直连
   Claude Code 的 `stream-json` CLI，也不用 Claude Agent SDK 直连 API。
2. 开关形式为 **启动配置**：环境变量或 CLI 参数，二选一后端，不要求
   两个后端同时存活。
3. Claude 后端做 **完整能力**：文本 + 工具审批 + 文件读写 + 终端执行。
4. **Codex 也迁移到 ACP**，最终删除 raw Codex 协议栈，只保留一套 ACP
   客户端。
5. **不引入新的 API key**：两个 ACP agent 都通过各自官方 CLI 的既有登录
   认证（`codex-acp` 驱动 Codex CLI，`claude-agent-acp` 驱动已登录的
   `claude` CLI），TaskMux 不需要 ANTHROPIC_API_KEY 或 OPENAI_API_KEY。
6. 实现采用 **官方 SDK + 增量迁移**（方案 A）：先打通 Claude，再把 Codex
   切到 ACP，最后删除 raw 栈。

## 3. 背景与现状

当前协议层：

- `src/server/codex/json-rpc-client.ts`：`CodexJsonRpcClient`，spawn
  `codex app-server`，手写 newline-delimited JSON-RPC。
- `src/server/codex/codex-adapter.ts`：`CodexAppServerAdapter`，把 Codex
  的 thread/turn/approval 事件映射到 `AgentAdapter`。
- `src/server/agent/agent-adapter.ts`：`AgentAdapter` 内部抽象（createSession
  / readSession / resumeSession / sendText / cancelTurn / respondToApproval
  / subscribe）。
- `src/server/main.ts`：`startTaskMux` 编排启动、诊断、重启与 degraded
  health。

本设计**保留** `AgentAdapter` 接口与 `ReplaceableAgentAdapter`，只替换其
下的协议实现。

### 3.1 ACP 关键事实

ACP 是客户端（app）与 agent 之间的标准协议。`@agentclientprotocol/sdk`
提供客户端侧 API：

- `ClientApp` / `connect` / `ndJsonStream`：建立 stdio 连接并握手。
- `ClientContext`：调用 agent 侧方法（`session/new`、`session/load`、
  `session/prompt`、`session/cancel` 等）。
- 客户端 handler：实现 agent 反向调用的
  `fs/read_text_file`、`fs/write_text_file`、`terminal/*`、以及响应
  `session/request_permission`。

`codex-acp` 与 `claude-agent-acp` 都会把文件读写与终端执行**委托给客户端**，
因此 TaskMux 作为 ACP 客户端必须自己实现 fs 与 terminal。

## 4. 总体架构

新增 `src/server/acp/` 目录：

| 模块 | 职责 |
|---|---|
| `acp-client.ts` | `AcpClient`：基于 SDK 的 `ClientApp` + `ndJsonStream`，spawn `codex-acp` 或 `claude-agent-acp`，完成 `initialize` 握手，暴露类型化方法（sessionNew/sessionLoad/sessionPrompt/sessionCancel）与事件订阅、`stop`。对标 `CodexJsonRpcClient`。 |
| `acp-adapter.ts` | `AcpAgentAdapter implements AgentAdapter`：把 ACP 会话与事件映射到现有 `AgentAdapter` + `AgentAdapterEvent`。 |
| `acp-fs.ts` | 实现 `fs/read_text_file`、`fs/write_text_file`，限制在 workspace 内。 |
| `acp-terminal.ts` | 实现 `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/release`、`terminal/kill`。 |
| `acp-diagnostics.ts` | 把 `diagnoseCodex` 泛化为按后端类型诊断（未安装 / 认证 / 版本不兼容）。 |

`src/server/agent/`（接口与代理）不变；`src/server/main.ts` 按配置选择后端
对应的二进制与适配器工厂；其余（HTTP、事件总线、会话仓库、前端）不变。

## 5. 协议映射

### 5.1 方法映射

| `AgentAdapter` | ACP |
|---|---|
| `createSession(ws)` | `session/new { cwd: ws }` → `sessionId` 作为 `externalSessionId` |
| `readSession(id)` | `session/load { sessionId }` → 缓存流式回放 → 投影为 `MessageTurn[]` |
| `resumeSession(id)` | 仅当该会话不是当前已加载会话时执行 `session/load` |
| `sendText(id, text, opId)` | `session/prompt { sessionId, prompt: [{type:"text", text}] }`；resolve 即本轮结束 |
| `cancelTurn(id)` | `session/cancel { sessionId }` |
| `respondToApproval(reqId, decision)` | 回 `session/request_permission`：`{outcome:"selected", optionId}` 或 `{outcome:"cancelled"}` |

### 5.2 事件映射

- `session/update`:`agent_message_chunk` → `text_delta`
- `session/update`:`tool_call`（started）与 `tool_call_update`（completed/failed/declined）→ `tool_status`
- `session/request_permission` → `approval_requested`（label 从 `toolCall.title`/`name` 派生）
- `session/prompt` 完成 → `turn_completed`

### 5.3 关键差异

1. **ACP 没有 turnId**：`AcpAgentAdapter` 在发起 `session/prompt` 时自生成
   turnId（`randomUUID`），并在该轮所有事件里统一携带。
2. **`session/load` 流式回放历史**（`user_message_chunk` + `agent_message_chunk`），
   不是结构化 turns。`readSession` 需缓存并按 user/assistant 重组为
   `MessageTurn[]`。
3. **`session/request_permission` 是请求-响应**：客户端必须在审批结果确定后
   回 `selected`（选择首个 option）或 `cancelled`；取消整轮时对未决审批回
   `cancelled`。

## 6. 文件读写与终端执行

### 6.1 fs

- `fs/read_text_file`：读取 workspace 内文本文件。
- `fs/write_text_file`：写入 workspace 内文件（含创建父目录）。
- 路径安全：对请求路径做解析 + symlink 解析后，必须仍位于 workspace（或
  `additionalDirectories`）内；越界返回协议错误。
- 审批与 fs/terminal 的关系：工具审批由 `session/request_permission` 完成；
  fs/terminal 请求在审批通过后由 agent 直接发起，handler 直接执行。

### 6.2 terminal

- `terminal/create`：以 workspace 为 cwd，用用户默认 shell（`$SHELL`，
  回退 `/bin/sh`）spawn 进程，管道方式，返回终端句柄。
- `terminal/output`：向终端 stdin 写入数据。
- 输出：终端 stdout/stderr 流式转发回 agent。
- `terminal/wait_for_exit` / `release` / `kill`：管理退出、释放与强杀。
- 生命周期：会话关闭或客户端 `stop` 时清理所有残留终端进程。

## 7. 配置与开关

- `ServerConfig` 增加 `agent: "codex" | "claude"`，默认 `"codex"`（向后兼容）。
- 来源：`TASKMUX_AGENT` 环境变量或 `--agent` CLI 参数（CLI 优先），沿用
  `parseServerConfig` 现有风格。
- 二进制映射：`codex` → `codex-acp`；`claude` → `claude-agent-acp`。
- 可选 `TASKMUX_ACP_PATH` 覆盖二进制路径（调试/自定义安装用）。

## 8. 错误处理与诊断

- 保留现有 degraded health、重启预算与崩溃恢复机制。
- 诊断泛化：
  - ACP initialize 失败或 agent 版本不兼容 → `agent_version_unsupported`
  - ACP 认证失败 → `agent_not_authenticated`
  - transport 崩溃 → `app_server_exited` 沿用
- 迁移期保留旧 `codex_*` 错误码兼容；迁移完成后统一为 `agent_*`。

## 9. 测试策略

- **单测**：用 SDK 的 `AgentApp` + `connect` 组合内存 fake agent（不 spawn
  进程），覆盖 `AcpAgentAdapter` 的事件映射、`session/load` 历史重组、
  `session/request_permission` 审批流、fs 越界拒绝、terminal 生命周期。
- **e2e**：新增（或替换现有 fake-app-server 为）fake ACP agent；Playwright
  用例的业务语义不变（新建会话、流式回复、审批、重启续历史）。
- **真实验证**：`claude-agent-acp` 与 `codex-acp` 各跑一次真实 smoke（各发
  一条消息并观察流式输出），不自动批准任何工具。

## 10. 迁移步骤（方案 A）

1. **阶段 1**：新增 `src/server/acp/` 全套与配置开关；`agent=claude` 走新
   ACP 栈，`agent=codex` 暂走现有 raw 栈。先打通 Claude 端到端。
2. **阶段 2**：把 Codex 切到 `codex-acp`，复用同一套 `AcpAgentAdapter`、
   fs、terminal；验证 codex 后端无回归。
3. **阶段 3**：删除 `src/server/codex/json-rpc-client.ts`、
   `codex-adapter.ts` 及 raw 栈测试；清理 `codex_*` 命名与 dead 分支。

## 11. 范围外

- 不做运行时/每会话切换后端（只做启动配置）。
- 不实现 ACP 的 `session/fork`、`session/delete`、`session/list`、goal
  extension、elicitation、subagent-transcript 等可选扩展。
- 不引入 ACP auth 转发（浏览器登录 ChatGPT 等），认证完全由 agent 侧
  既有 CLI 登录承担。
- 不改前端 UI 契约与 `AgentAdapter` 接口形状（除确有必要的最小扩展外）。
