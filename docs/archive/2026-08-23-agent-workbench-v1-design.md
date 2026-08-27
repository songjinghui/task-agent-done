---
feature_ids: [taskmux-historical-agent-workbench-v1]
topics: [taskmux, single-agent, multi-agent, architecture, product-history]
doc_kind: archived-spec
created: 2026-08-23
superseded_by: docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md
---

# Agent Workbench 第一版设计与后续规划

> Historical design input. The current canonical design is the superseding document above.

## 1. 文档目的

本文定义一个可演进的 Agent 工作台第一版：先用一个 CLI、一个 Agent
走通完整会话闭环，同时为后续多 CLI、多 Agent 协作和纯 SQL 会话存储
预留稳定边界。

第一版不追求复制 Codeg 当前的全部生产能力。它要证明最核心的链路可靠：

```text
用户输入
→ 调用一个 Agent CLI
→ 接收流式文本和工具事件
→ 统一状态管理与渲染
→ 完成本轮
→ 刷新或重启后恢复
→ 继续同一会话
```

## 2. 已确定的设计决策

1. 第一版只适配一个 CLI。
2. 第一版只运行一个 Agent，不实现 Developer/Reviewer 协作。
3. 单 Agent 仍作为一个 `TaskRun` 下的 `AgentExecution` 运行。
4. `TaskRun`、`AgentExecution` 和 `CliSession` 是三个不同概念。
5. 实时处理和前端渲染只依赖统一领域模型，不依赖具体 CLI 格式。
6. 第一版采用混合存储：应用数据库保存业务元数据，完整正文暂由原 CLI
   transcript 保存。
7. Agent 间未来通过协调器和结构化交接通信，不直接自由群聊。
8. 未识别的工具必须能通过通用工具卡片展示，不能因为缺少专用适配而丢失。

## 3. 核心领域模型

### 3.1 三层会话身份

```text
TaskRun
└── AgentExecution
    └── CliSession
```

- `TaskRun`：用户希望完成的一项工作，是未来多 Agent 协作的容器。
- `AgentExecution`：某个 Agent 在该工作中的一次独立执行。
- `CliSession`：Codex、Claude 等原生 CLI 自己的会话。

第一版中三者是一对一关系，但不能合并成同一个 ID：

```text
TaskRun 1 ── 1 AgentExecution 1 ── 1 CliSession
```

后续多 Agent 扩展为：

```text
TaskRun 1 ── N AgentExecution
                 └── 每个 Execution 绑定自己的 CliSession
```

### 3.2 统一输入模型

```ts
type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "resource"; uri: string; text?: string; blob?: string }
  | { type: "resource_link"; uri: string; label: string }
```

前端、任务系统和未来的 Agent 协调器都生成同一种 `PromptBlock[]`。
CLI 特有格式只能在 Adapter 边界出现。

### 3.3 统一实时事件

```ts
type AgentEventEnvelope = {
  runId: string
  executionId: string
  agentType: string
  cliSessionId: string | null
  seq: number
  payload: AgentEvent
}

type AgentEvent =
  | { type: "status_changed"; status: ExecutionStatus }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_started"; call: NormalizedToolCall }
  | { type: "tool_updated"; update: NormalizedToolUpdate }
  | { type: "permission_requested"; request: PermissionRequest }
  | { type: "usage_updated"; usage: TokenUsage }
  | { type: "turn_completed"; reason: TurnStopReason }
  | { type: "error"; error: AgentError }
```

即使第一版只有一个 Agent，事件也必须携带 `runId` 和 `executionId`。前端状态
必须按 ID 存储，不能使用全局唯一的 `currentAgent` 或 `liveMessage`。

### 3.4 统一历史模型

```ts
type ConversationDetail = {
  executionId: string
  turns: MessageTurn[]
  stats?: SessionStats
}

type MessageTurn = {
  id: string
  role: "user" | "assistant"
  blocks: ContentBlock[]
  startedAt: string
  completedAt?: string
}
```

历史数据无论来自 JSONL、CLI SQLite 还是应用 SQL，都必须先转换为该模型，
再交给前端渲染。

## 4. 第一版架构

```text
Frontend Composer
  ↓ PromptBlock[]
Application API / Transport
  ↓
SingleAgentCoordinator
  ↓
AgentRuntime
  ↓
AgentAdapter
  ↓
One CLI / ACP Process
  ↓ raw events
AgentAdapter normalizer
  ↓ AgentEventEnvelope
Runtime Store
  ↓
Unified Renderer
```

### 4.1 `SingleAgentCoordinator`

第一版协调器只做最薄的一层转发：

```ts
interface RunCoordinator {
  startRun(input: StartRunInput): Promise<TaskRun>
  send(runId: string, blocks: PromptBlock[]): Promise<void>
  cancel(runId: string): Promise<void>
  resume(runId: string): Promise<void>
}
```

它创建一个 `AgentExecution` 并调用 `AgentRuntime`。业务 API 和 UI 依赖
`RunCoordinator`，不能直接依赖具体 CLI。未来替换为开发—评审协调器时，
入口接口保持不变。

### 4.2 `AgentRuntime`

```ts
interface AgentRuntime {
  createExecution(config: AgentExecutionConfig): Promise<string>
  sendPrompt(executionId: string, blocks: PromptBlock[]): Promise<void>
  cancel(executionId: string): Promise<void>
  reconnect(executionId: string): Promise<void>
  subscribe(
    executionId: string,
    handler: (event: AgentEventEnvelope) => void
  ): Unsubscribe
}
```

Runtime 必须支持按 `executionId` 管理多个实例，即使第一版 Map 中只有一个实例。
禁止使用全局 CLI 进程、全局当前 Session 或全局 `turnInFlight`。

### 4.3 `AgentAdapter`

```ts
interface AgentAdapter {
  metadata(): AgentMetadata
  capabilities(): AgentCapabilities
  launch(config: LaunchConfig): Promise<AgentConnection>
  toCliPrompt(blocks: PromptBlock[]): CliPromptBlock[]
  normalizeEvent(event: unknown, context: EventContext): AgentEvent[]
  transcriptStore(): TranscriptStore
}
```

第一版只有一个实现。Adapter 负责以下 CLI 差异：

- 启动命令、参数、环境变量和配置目录；
- Session 创建、恢复和 ID 绑定；
- 图片、资源和 Skill 调用格式；
- 流式文本、思考、工具、错误和完成事件；
- 原生 transcript 路径和格式。

通用状态管理、业务数据库和 UI 禁止出现具体 CLI 的原始事件结构。

### 4.4 工具归一化与渲染

```ts
type NormalizedToolCall = {
  id: string
  name: string
  category: "terminal" | "read" | "write" | "search" | "question" | "generic"
  status: "pending" | "running" | "completed" | "failed"
  rawInput: unknown
  rawOutput?: unknown
  display?: Record<string, unknown>
}
```

渲染策略：

```text
terminal → TerminalCard
write    → DiffCard
question → QuestionCard
未知工具 → GenericToolCard
```

第一版至少实现文本和 `GenericToolCard`。可以只为第一个 CLI 最常用的一种工具
增加专用卡片，但所有未知工具必须保留原始名称、输入、输出和状态。

## 5. 第一版存储设计

### 5.1 应用数据库

第一版至少包含：

```text
task_run
├── id
├── title
├── status
├── workflow_type = single_agent
├── workflow_phase
├── coordinator_state_json
├── created_at
└── updated_at

agent_execution
├── id
├── run_id
├── role = agent
├── agent_type
├── status
├── external_session_id
├── attempt
├── created_at
└── updated_at
```

关系必须从第一版就是：

```text
task_run 1 ── N agent_execution
```

应用逻辑暂时限制每个 Run 只能创建一个 Execution，而不是在数据库结构中设置
一对一限制。

### 5.2 Transcript 存储抽象

```ts
interface TranscriptStore {
  getConversation(execution: AgentExecution): Promise<ConversationDetail>
  getTurns(
    execution: AgentExecution,
    options: PaginationOptions
  ): Promise<MessageTurn[]>
}
```

第一版实现 `NativeCliTranscriptStore`：

```text
agentType + externalSessionId
→ 读取原 CLI JSONL / SQLite
→ 转换为 ConversationDetail
```

未来可以增加 `SqlTranscriptStore`，但两者返回相同领域模型，因此前端、
Coordinator 和渲染层无需修改。

必须区分：

- UI 历史存储：可以未来完全迁移到应用 SQL；
- CLI 上下文恢复：只要仍使用第三方 CLI，就可能继续依赖原生 Session。

## 6. 第一版必须完成的能力

### 6.1 P0：端到端文本闭环

- 创建 `TaskRun` 和一个 `AgentExecution`；
- 启动并连接一个 CLI；
- 发送文本 Prompt；
- 接收并显示流式文本；
- 正确处理 `turn_completed`；
- 禁止同一 Execution 同时运行两个 Turn；
- 每个事件都有单调递增的 `seq`；
- 错误可见且不会让连接永久卡在运行中。

### 6.2 P1：持久化与恢复

- 保存 Run、Execution、状态和 `externalSessionId`；
- 页面刷新后重新加载历史；
- 应用重启后恢复 CLI Session，或明确降级为新 Session；
- 恢复后可以继续发送下一轮；
- 运行时流式消息和落盘历史不会重复；
- 取消、失败和正常完成有明确且可恢复的状态。

### 6.3 P2：最小工具支持

- 识别工具开始、更新和完成；
- 使用 `toolCallId` 原地更新同一工具；
- 未知工具使用通用卡片；
- 工具原始输入和输出不丢失；
- 至少实现批准或拒绝一种权限请求；
- Turn 结束后不能残留永久运行中的工具卡片。

### 6.4 P3：可观测性与验证

- 日志可以通过 `runId`、`executionId` 和 `cliSessionId` 关联；
- 保存或采样原始 CLI 事件，便于编写适配器回归测试；
- 测试重复事件、乱序事件、快速双击发送、刷新、断线和 CLI 异常退出；
- 对历史 Parser 使用真实脱敏 transcript fixture；
- 至少有一个端到端测试覆盖发送、流式完成、刷新恢复和继续对话。

## 7. 第一版明确不做

- 第二种 CLI；
- Developer/Reviewer 多 Agent 协作；
- Agent 自由群聊；
- 通用工作流编辑器；
- Agent 间 Handoff 和 Artifact 数据表；
- 并行 Agent 调度；
- 多窗口和远程桌面；
- 完整 Skill 管理市场；
- 所有工具的专用 UI；
- 纯 SQL 唯一会话存储；
- 对第三方 CLI transcript 的反向写入。

## 8. 防止后续推翻的扩展边界

第一版必须保留以下结构，但不实现对应高级功能。

### 8.1 多 Agent

- `TaskRun` 与 `AgentExecution` 一对多；
- 所有运行状态按 `executionId` 管理；
- 所有事件携带 `runId`、`executionId` 和 `agentType`；
- Coordinator 与 AgentRuntime 分离；
- CLI Session 不等同于业务 Run；
- UI 数据模型允许一个 Run 下出现多个 Execution。

### 8.2 多 CLI

- 具体 CLI 只能通过 `AgentAdapter` 接入；
- Adapter 使用 Capability 声明，而不是让 UI 猜测能力；
- 历史读取通过 `TranscriptStore`；
- 未知工具和未知事件提供安全降级；
- Agent 特例不能泄漏到通用业务模型。

### 8.3 可替换存储

- Runtime、Repository 和 Projection 分离；
- UI 不直接读取 CLI 文件或数据库行；
- Repository 返回统一 `ConversationDetail`；
- 附件和大工具输出使用 URI/Blob 引用，避免把数据库结构绑定到 Base64；
- Schema 迁移不改变事件和渲染协议。

### 8.4 未来协作

未来的平等 Agent 仍由 Coordinator 编排，而不是相互直接无限对话。预期增加：

```text
handoff
├── run_id
├── from_execution_id
├── to_execution_id
├── kind
├── correlation_id
└── payload_json

artifact
├── run_id
├── producer_execution_id
├── kind
├── uri
├── content_hash
└── metadata_json
```

Developer 和 Reviewer 没有主从关系；二者通过同一个 `runId` 和结构化 Handoff
协作。Coordinator 只负责顺序、状态和终止条件。

## 9. 第一版验收标准

第一版只有在以下场景全部成立时才算完成：

1. 用户可以创建一次新任务并收到流式回答。
2. 文本增量没有明显重复、丢失或乱序。
3. 快速连续发送不会让同一 Agent 同时执行两个 Turn。
4. 工具调用能够创建、更新并结束；未知工具能够展示原始数据。
5. 正常完成、用户取消和 CLI 异常退出都能退出运行状态。
6. 页面刷新后能显示已经完成的历史。
7. 应用重启后能恢复或安全降级，并继续下一轮。
8. 日志可以关联一次 Run、一个 Execution 和对应 CLI Session。
9. 通用核心没有直接依赖第一个 CLI 的原始消息类型。
10. 数据库和状态容器没有一对一或全局单 Agent 的硬编码假设。

## 10. 第一版实施里程碑

### M0：领域骨架

- 定义核心 ID、状态和统一事件；
- 建立 `TaskRun`、`AgentExecution` 和 Repository；
- 建立 `SingleAgentCoordinator`、`AgentRuntime`、`AgentAdapter` 接口；
- 暂时使用 Fake Adapter 验证事件流和 UI。

### M1：单 CLI 纯文本

- 实现第一个真实 Adapter；
- 完成启动、连接、Session 创建和文本 Prompt；
- 完成流式文本与 TurnComplete。

### M2：历史与恢复

- 实现 Native CLI TranscriptStore；
- 保存 `externalSessionId`；
- 完成刷新、重启、resume/load/new 降级链。

### M3：工具与交互

- 实现标准 ToolCall 生命周期；
- 实现 GenericToolCard；
- 实现一种权限交互；
- 加入取消、失败和超时处理。

### M4：稳定性

- 增加事件序号、去重和快照；
- 增加断线、重连和进程退出测试；
- 使用真实 transcript fixture 建立回归测试；
- 完成端到端验收。

## 11. 第一版之后的规划

### Phase 2：接入第二个 CLI，验证抽象

目标不是增加 Agent 数量，而是验证通用边界是否真实成立。

- 新增第二个 `AgentAdapter`；
- 对比两个 CLI 的 Session、图片、工具、错误和 stop reason；
- 把第一个 Adapter 泄漏到核心的特例移回适配层；
- 冻结第一版统一事件和历史模型；
- 增加每个 CLI 的 fixture 与兼容测试。

完成标准：新增第二个 CLI 不需要修改主要 UI、Coordinator 或数据库关系。

### Phase 3：完整生产稳定性

- 权限队列、用户提问和计划审批；
- ToolCall 高频更新批处理；
- 事件快照和断线续传；
- Token usage、上下文窗口和错误诊断；
- 附件持久化和清理；
- 多窗口或 WebSocket 连接一致性。

### Phase 4：Developer/Reviewer 协作

新增：

- `DevelopmentReviewCoordinator`；
- `handoff`、`artifact` 和工作流转换记录；
- Developer、Reviewer 角色；
- `development → review → revision → accepted` 状态机；
- 最大 Review 轮次和人工接管；
- 一个 Run 下多个 Execution 的 UI；
- 级联取消、单 Agent 重试和应用重启恢复。

流程保持结构化：

```text
Developer Execution
→ ImplementationReady Handoff
→ Reviewer Execution
→ ReviewCompleted Handoff
→ Accepted 或 RevisionRequested
```

### Phase 5：SQL Transcript Projection

先让 SQL 成为 UI 历史的权威来源，不立即替代 CLI 的上下文恢复：

```text
CLI 实时事件
├── 原 CLI transcript
└── SQL normalized projection

UI 历史 → SQL
CLI resume → 原 CLI Session
```

包括：

- `conversation_turn`、`content_block`、`tool_call` 表；
- 流式事件到 SQL Turn 的事务投影；
- Native CLI transcript 到 SQL 的导入；
- 数据一致性校验和重建；
- `SqlTranscriptStore` 替换读取路径。

只有在不再依赖第三方 CLI Session、或 CLI 支持完整外部历史导入时，才评估
“纯 SQL 唯一存储”。

### Phase 6：通用协作与更多 Agent

- 配置化角色和工作流；
- 并行 Agent Execution；
- Artifact 冲突检测；
- 更细粒度的上下文选择和 Token 预算；
- Agent 能力匹配和动态调度；
- 协作过程审计、回放和成本统计。

这一阶段之前不实现自由群聊。只有当固定工作流无法覆盖真实需求时，再设计
Agent 间开放式消息协议和终止策略。

## 12. 粗略时间预估

以下是一名熟悉所选技术栈的开发者全职投入的范围，不包含产品设计反复和
第三方 CLI 严重兼容问题：

| 阶段 | 预计时间 |
| --- | --- |
| M0 领域骨架 | 3～5 天 |
| M1 单 CLI 纯文本 | 4～7 天 |
| M2 历史与恢复 | 1～2 周 |
| M3 工具与交互 | 1～2 周 |
| M4 稳定性与验收 | 1～2 周 |
| 第一版合计 | 5～8 周 |
| 第二个 CLI | 1～3 周 |
| Developer/Reviewer 协作 | 3～6 周 |
| SQL 历史投影 | 2～4 周 |

## 13. 架构护栏

出现以下代码时应暂停并重新检查边界：

- 用一个 `sessionId` 同时表示 Task、Execution 和 CLI Session；
- 在通用 UI 中判断具体 CLI；
- 使用全局唯一的 Agent Connection 或 `turnInFlight`；
- 让 Adapter 直接修改 UI Store；
- 让 Coordinator 解析自然语言 transcript 判断工作流状态；
- 依赖最后一条消息完成 Agent 间交接；
- 未知工具直接丢弃；
- 把原始 CLI JSON 作为前端长期公共协议；
- 让 SQL 表结构直接成为渲染组件 Props；
- 为尚未出现的多 Agent 模式提前实现通用工作流引擎。

坚持这些边界后，第一版的单 Agent 能力会成为后续多 Agent 的稳定执行单元，
而不是需要被推翻的临时实现。
