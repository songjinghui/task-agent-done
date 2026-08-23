# TaskMux 纯文本 Agent Workbench V1 设计

**状态：** 已确认，等待用户审阅书面规格

**日期：** 2026-08-23

**产品：** TaskMux

**实施仓库：** 独立 `taskmux` 项目，不复用 Codeg 代码

## 1. 目标

TaskMux V1 是一个绑定单一 Workspace 的本地网页工作台。它连接真实 Codex
CLI，让用户创建、切换和继续纯文本会话。

核心闭环是：

```text
指定 Workspace 启动 TaskMux
→ 新建 Codex 会话
→ 发送纯文本
→ 流式显示 Agent 文本
→ 显示精简工具状态并处理必要审批
→ 完成本轮并继续多轮对话
→ 刷新或重启后加载历史并继续原会话
```

V1 的目标是验证一个小而完整、可日常使用的会话工作台，不实现通用 Agent
平台。

## 2. 已确认的产品决策

1. TaskMux 是独立应用，不复用 Codeg 源码，只将其作为设计参考。
2. 运行形态是本地 Node.js 服务加 React 网页。
3. 第一版只接入 Codex CLI。
4. 一个 TaskMux 服务实例只绑定启动时指定的一个 Workspace。
5. 会话入口采用左侧会话列表和右侧当前对话。
6. 只列出由 TaskMux 创建的会话，不导入本机已有 Codex 历史。
7. 输入和主要输出只支持纯文本。
8. 工具调用只显示一行状态，不显示原始输入、输出或 Diff。
9. 命令执行和文件修改审批使用最小批准或拒绝交互。
10. SQLite 只保存 TaskMux 自有会话索引和状态，消息正文由 Codex 原生会话
    保存。
11. 页面刷新或应用重启后，可以加载已完成历史并继续原 Codex Session。
12. V1 不恢复刷新前仍在进行的半截流式 Turn。

## 3. 接入方案

### 3.1 采用 Codex App Server

后端启动一个本地进程：

```text
codex app-server --stdio
```

Node.js 与该进程通过 stdio 上的 JSONL/JSON-RPC 通信。TaskMux 使用稳定接口：

- `initialize` / `initialized`：建立客户端连接；
- `thread/start`：创建新会话；
- `thread/read`：读取已保存历史；
- `thread/resume`：继续已保存会话；
- `turn/start`：发送用户文本；
- `turn/interrupt`：取消当前 Turn；
- `item/agentMessage/delta`：接收文本增量；
- `item/started` / `item/completed`：归纳工具状态；
- `turn/completed`：结束当前 Turn；
- 命令执行和文件修改 Approval Request：请求用户决定。

官方将 App Server 定位为嵌入产品时使用的深度集成接口，覆盖会话历史、审批和
流式 Agent 事件：
[Codex App Server documentation](https://developers.openai.com/codex/app-server/)。

V1 不启用 `experimentalApi`，避免把核心流程绑定到实验字段。

### 3.2 未采用的方案

`codex exec --json` 更适合一次性自动化任务。将它用于交互工作台会增加多轮
恢复、审批和进程生命周期的拼接工作。

PTY 包装 Codex TUI 需要解析终端字符流，协议脆弱，无法形成可靠的领域边界。

## 4. 技术架构

V1 使用一个 TypeScript 工程，不建立多包 Monorepo：

```text
src/
├── client/       React 页面、状态和渲染
├── server/       Fastify、SQLite、Codex 进程和实时事件
└── shared/       API DTO、领域类型和事件类型
```

技术选型：

- Node.js LTS；
- TypeScript strict；
- React + Vite；
- Fastify；
- SQLite；
- Server-Sent Events 用于后端到浏览器的流式事件；
- REST 用于查询、新建、发送、取消和审批；
- Vitest、React Testing Library 和 Playwright；
- pnpm。

开发环境由 Vite 提供前端开发服务并代理 API。生产环境由 Fastify 提供构建后
的静态网页和 API。

## 5. 组件边界

### 5.1 `CodexAppServerClient`

职责：

- 启动和监督 `codex app-server --stdio`；
- 完成初始化握手；
- 为客户端请求分配 JSON-RPC ID 并关联响应；
- 解析逐行 JSON 消息；
- 分发 Codex 通知和服务端发起的审批请求；
- 处理 stderr、进程退出和一次自动重启。

该组件只理解 Codex 协议，不读写 HTTP、React 或 SQLite。

### 5.2 `CodexAdapter`

职责：

- 将 TaskMux 的新建、读取、恢复、发送和取消操作映射到 App Server 方法；
- 将 Agent 文本、工具状态、Turn 完成和错误转换为统一事件；
- 将 TaskMux 的批准或拒绝决定映射为 Codex Approval Response；
- 隐藏 Codex 原始消息形状，避免协议类型泄漏到 UI。

### 5.3 `ConversationService`

职责：

- 创建和查询 TaskMux 会话；
- 关联 TaskMux `conversationId` 与 Codex `threadId`；
- 管理每个会话的运行状态；
- 执行全局单活动 Turn 和单会话单 Turn 约束；
- 调用 Adapter 读取或恢复历史；
- 在异常、取消和完成时释放运行锁。

状态按 `conversationId` 存储。虽然 V1 全局只允许一个活动 Turn，但不使用
无归属的 `currentSession` 或 `turnInFlight` 全局布尔值。

### 5.4 `EventHub`

职责：

- 为浏览器 SSE 连接广播统一事件；
- 为事件添加单调递增的进程内 `seq`；
- 按 `conversationId` 路由事件；
- 浏览器断开时清理订阅。

V1 不持久化或重放 SSE 事件。刷新后通过读取 Codex 完整历史恢复已完成内容。

### 5.5 React Client

职责：

- 加载 TaskMux 会话列表；
- 加载选中会话的历史；
- 订阅 SSE 并追加实时文本；
- 显示工具的一行状态；
- 显示并提交 Approval 决定；
- 管理输入框、发送、取消和错误提示。

React Client 只依赖 TaskMux DTO，不接触 Codex JSON-RPC 类型。

## 6. 领域模型与存储

### 6.1 SQLite 模型

V1 只有一张核心业务表：

```text
conversation
├── id                  TEXT PRIMARY KEY
├── codex_thread_id     TEXT NOT NULL UNIQUE
├── title               TEXT NOT NULL
├── status              TEXT NOT NULL
├── created_at          TEXT NOT NULL
└── updated_at          TEXT NOT NULL
```

`status` 仅允许：

```text
idle | running | failed | interrupted
```

数据库还包含迁移版本表。数据库存放在操作系统应用数据目录，可由
`TASKMUX_DATA_DIR` 覆盖；不得默认写入用户的代码 Workspace。

新建记录的初始标题是“新会话”。第一条用户消息发送成功后，服务将其去除
多余空白并截断为正式标题。V1 不支持手动重命名。

### 6.2 统一历史模型

```ts
type ConversationDetail = {
  conversationId: string
  codexThreadId: string
  turns: MessageTurn[]
}

type MessageTurn = {
  id: string
  role: "user" | "assistant"
  text: string
  status: "completed" | "interrupted" | "failed"
}
```

历史通过 `thread/read(includeTurns=true)` 获取并转换。SQLite 不复制消息正文，
TaskMux 也不自行解析 Codex rollout JSONL。

### 6.3 实时事件模型

```ts
type ConversationEventEnvelope = {
  conversationId: string
  seq: number
  payload: ConversationEvent
}

type ConversationEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "tool_status"; tool: ToolStatus }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "turn_completed"; turnId: string }
  | { type: "turn_interrupted"; turnId: string }
  | { type: "error"; code: string; message: string }

type ToolStatus = {
  id: string
  label: string
  status: "running" | "completed" | "failed" | "declined"
}
```

## 7. HTTP 与 SSE 接口

```text
GET    /api/health
GET    /api/workspace
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
POST   /api/conversations/:id/messages
POST   /api/conversations/:id/cancel
POST   /api/conversations/:id/approvals/:requestId
GET    /api/events
```

规则：

- `POST /conversations` 调用 `thread/start` 并保存返回的 `threadId`；
- 首次发送后生成本地标题；
- `GET /conversations/:id` 使用 `thread/read` 加载历史；
- 向已存在的会话发送前，服务确保该 Thread 已 `thread/resume`；
- 活动 Turn 存在时再次发送返回 HTTP `409`；
- Approval Body 只允许 `accept` 或 `decline`；
- 所有会话 ID 必须先在 SQLite 中查到，客户端不能直接提交任意 Codex
  `threadId`。

## 8. 页面与交互

页面由固定侧栏和主区域构成。

侧栏包含：

- Workspace 名称；
- “新建会话”按钮；
- TaskMux 创建的会话列表；
- 会话标题、状态和最近更新时间。

主区域包含：

- 用户与 Assistant 的纯文本消息；
- 当前 Turn 的流式文本；
- 一行工具状态；
- 最小 Approval 提示；
- 错误提示及可行的恢复动作；
- 底部文本输入框、发送按钮和运行时取消按钮。

工具展示示例：

```text
◌ 运行命令：pnpm test
✓ 运行命令：完成
✕ 修改文件：已拒绝
```

工具行不展示命令参数、stdout、stderr、文件内容、Diff 或原始 JSON。

## 9. 核心流程

### 9.1 启动

```text
taskmux --workspace /absolute/project/path
→ 解析并规范化绝对路径
→ 验证目录存在且可访问
→ 打开 SQLite 并执行迁移
→ 启动 Codex App Server
→ 完成 initialize / initialized
→ 启动 HTTP 服务
```

服务只绑定 loopback 地址。V1 不提供远程访问和身份验证。

### 9.2 新建会话

```text
用户点击新建
→ ConversationService 调用 thread/start(cwd=固定 Workspace)
→ 保存 TaskMux conversationId 与 Codex threadId
→ 打开空白会话
```

TaskMux 复用用户现有的 Codex 安装、登录状态和配置，不读取或保存 OpenAI
凭据。

### 9.3 发送与流式显示

```text
用户发送文本
→ 校验非空、长度限制和运行锁
→ turn/start
→ text delta 经 Adapter 转为统一事件
→ EventHub 通过 SSE 广播
→ React 按 turnId 原地追加文本
→ turn/completed 后状态回到 idle
```

输入最大长度为 100,000 个 Unicode code point。超出时在客户端和服务端同时
拒绝。

### 9.4 刷新和重启恢复

```text
读取 SQLite 会话索引
→ thread/read(includeTurns=true)
→ 转换为 ConversationDetail
→ 渲染已完成历史
→ 下一次发送前 thread/resume
```

V1 只支持一个浏览器客户端。浏览器刷新导致唯一 SSE 连接断开时，服务调用
`turn/interrupt` 并将活动会话标记为 `interrupted`。服务进程异常退出后，下次
启动会把数据库中残留的 `running` 状态改为 `interrupted`。V1 不重连半截
Turn；用户可以在读取到的已落盘历史基础上发送下一轮。

## 10. 工具与审批策略

V1 将 Codex 工具事件归纳为有限标签，例如：

- `运行命令`；
- `修改文件`；
- `使用工具`。

同一个工具使用原始 item ID 原地更新状态。Turn 结束时仍处于 `running` 的工具
必须转为 `failed` 或 `declined`，不能永久显示运行中。

V1 支持：

- 命令执行 Approval；
- 文件修改 Approval；
- `accept`；
- `decline`。

未知的服务端交互请求不能静默等待。Adapter 将其安全拒绝，并向 UI 发送
`unsupported_interaction` 错误。V1 不提供“本会话始终批准”、权限配置、网络
权限细分或 MCP 表单交互。

## 11. 并发与状态约束

1. 每个会话最多一个活动 Turn。
2. V1 整个 TaskMux 实例最多一个活动 Turn。
3. 运行状态必须归属于 `conversationId`。
4. 快速重复发送的第二个请求返回 `409 Conflict`。
5. 活动 Turn 存在时可以查看其他已完成会话，但不能在其他会话发送。
6. 完成、取消、拒绝、协议错误和进程退出都必须释放运行锁。
7. 取消是幂等操作；没有活动 Turn 时返回成功但不产生额外事件。

## 12. 错误处理

UI 必须区分并展示：

- `codex_not_found`：Codex CLI 未安装；
- `codex_version_unsupported`：Codex 不支持所需 App Server 接口；
- `codex_not_authenticated`：Codex 尚未登录；
- `workspace_invalid`：Workspace 不存在或不可访问；
- `app_server_exited`：App Server 异常退出；
- `thread_unavailable`：Thread 无法读取或恢复；
- `turn_start_failed`：Turn 启动失败；
- `event_stream_disconnected`：浏览器 SSE 断开；
- `approval_expired`：Approval 已失效；
- `unsupported_interaction`：Codex 请求了 V1 不支持的交互。

App Server 异常退出时：

1. 当前 Turn 标记为 `failed`；
2. 释放运行锁；
3. 自动重启 App Server 一次；
4. 重启成功后允许用户重新发送；
5. 再次失败后停止自动重试并显示人工重试动作。

## 13. 安全边界

- HTTP 服务默认只监听 `127.0.0.1`；
- Workspace 只由启动参数确定，网页不能扩大该范围；
- 后端使用参数数组启动 Codex，不拼接 Shell 命令字符串；
- 浏览器不能提交任意执行目录、二进制路径或 Codex Thread ID；
- TaskMux 不读取、传输或持久化 OpenAI 登录凭据；
- SQLite 默认位于操作系统应用数据目录，不污染代码仓库；
- Approval 默认不自动接受；
- 未知交互安全拒绝并显式报错。

## 14. 测试策略

### 14.1 Fake App Server

测试提供一个可执行的 Fake App Server，通过 JSONL 模拟：

- 初始化握手；
- Thread 创建、读取和恢复；
- 文本增量；
- 工具开始和完成；
- Approval Request；
- Turn 完成、取消和失败；
- 进程异常退出。

默认自动化测试不依赖真实 Codex 账号或用户会话数据。

### 14.2 单元和集成测试

- JSONL 分帧、请求关联和无效消息；
- Codex 事件归一化；
- SQLite 迁移与 Repository；
- 单活动 Turn 状态机；
- 重复发送和幂等取消；
- 工具原地状态更新；
- Approval 过期和未知交互拒绝；
- React 历史与流式文本合并；
- SSE 断开后的 UI 状态。

### 14.3 浏览器端到端测试

Playwright 使用 Fake App Server 覆盖：

```text
启动应用
→ 新建会话
→ 发送文本
→ 显示流式回答
→ 处理工具和 Approval
→ 完成本轮
→ 创建并切换第二个会话
→ 刷新并恢复历史
→ 重启服务并继续原会话
```

另提供一个默认不在 CI 运行的真实 Codex 冒烟测试。它只使用专门创建的临时
Workspace，不写入 TaskMux 仓库或用户的其他项目。

## 15. 验收标准

V1 完成必须同时满足：

1. 用户能通过绝对路径指定 Workspace 并启动应用。
2. 应用能识别 Codex 缺失、版本不兼容和未登录状态。
3. 用户能创建至少两个 TaskMux 会话并在二者之间切换。
4. 用户能发送纯文本并逐段看到 Agent 回复。
5. 同一时刻不会启动两个 Turn。
6. 工具状态能从运行更新为完成、失败或拒绝。
7. 命令执行和文件修改可以批准或拒绝。
8. 正常完成、取消、拒绝和进程退出都能退出运行状态。
9. 页面刷新后能够重新显示已完成历史。
10. 应用重启后能够继续原 Codex Session。
11. 前端和通用业务层不依赖 Codex 原始 JSON-RPC 类型。
12. Fake App Server 端到端测试通过。
13. 真实 Codex 冒烟测试能够在隔离 Workspace 中手动通过。

## 16. 明确不做

- 导入或扫描 TaskMux 之外创建的 Codex 会话；
- 图片、文件附件、资源引用和语音；
- Thinking 或 Reasoning 展示；
- 工具输入、输出、Diff 和专用卡片；
- 通用可展开工具卡片；
- 多 Workspace；
- 多 Agent、多 CLI 和 Agent 协作；
- Task、Review、Handoff 和 Artifact；
- 会话搜索、删除、归档、重命名和导出；
- 模型、推理等级、Sandbox、Skill 和 MCP 配置页面；
- Token Usage、成本和上下文窗口统计；
- 运行中刷新后的事件续传；
- 远程访问、账号系统和云同步；
- 桌面安装包。

通用可展开工具卡片是已确认的后续扩展，不属于 V1。

## 17. 实施切片与预估

1. 项目骨架、SQLite 和 Fake App Server：1～1.5 天；
2. Codex App Server Client 和 Adapter：1～1.5 天；
3. 会话列表、输入和流式文本：1～1.5 天；
4. 历史读取、刷新和重启恢复：1 天；
5. 工具状态、审批、取消和错误：1 天；
6. 浏览器 E2E、真实 Codex 冒烟与修整：1～1.5 天。

总计约 5～8 个工作日。若本机 Codex App Server 的稳定接口与文档行为出现差异，
先用最小协议 Spike 验证差异，再调整估算；不通过扩展 V1 功能来消化风险。
