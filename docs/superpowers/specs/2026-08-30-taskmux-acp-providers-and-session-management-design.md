---
feature_ids:
  - taskmux-v0-interaction-kernel
  - taskmux-acp-providers
  - taskmux-session-management
topics: [taskmux, acp, codex, claude, sessions, multi-agent, architecture, ui, thinking]
doc_kind: spec
created: 2026-08-30
status: approved
approved: 2026-08-30
supersedes:
  - docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md
source_threads:
  - thread_mtbh922hu8iqtyum
---

# TaskMux ACP 双 Provider 与会话管理设计

## 1. 产品契约

TaskMux 的终态仍是本地 Multi-Agent 交互系统，而不是 Provider 切换器。
当前阶段先交付一个 Agent 的完整对话体验，但每个会话在创建时可以选择
Codex 或 Claude。会话内的 Agent 身份、Execution 和 Provider Session 始终
分离，为后续同一 Thread 出现多个具名 Agent 保留稳定边界。

本设计按 co-creator 确认的顺序交付：

1. 先打通 Claude；
2. Codex 与 Claude 最终统一到 ACP；
3. 再完成 TaskMux 原生会话管理。

这些工作拆成三个可独立验收的交付，不进入一个巨型 PR。

## 2. 已确认决策

1. 新建 Thread 时选择 `codex` 或 `claude`；一个 Execution 的 Provider
   创建后不可更改。
2. 终态只保留 ACP 协议层：`codex-acp` 与 `claude-agent-acp` 共用
   TaskMux 的 ACP client、事件归一、审批和恢复逻辑。
3. 迁移期间允许 raw Codex App Server 暂时存在；ACP Codex 达到能力等价后
   必须删除 raw 栈，不能形成永久双轨。
4. 一个 Provider 对应一个长期运行的 ACP 子进程；一个子进程承载该
   Provider 的多个 Session。
5. Runtime 故障域按 Provider 隔离，Turn 所有权按 Execution 隔离；任何
   Provider 故障不得阻塞另一 Provider。
6. 首版只管理 TaskMux 自己创建的会话，不扫描、导入或接管 TaskMux 外的
   Codex/Claude CLI Session。
7. 会话管理首版包含创建、列表、切换、重命名、归档和恢复；不包含永久删除、
   搜索、标签、置顶或文件夹。
8. Thread、Execution 与 Provider Session 的用户可见元数据默认永久持久化，
   TTL 为零。

## 3. 范围与交付单元

### 3.1 Delivery A：Claude ACP vertical slice

- 收口当前未完成的 Execution-aware client store 与 API；
- 把 `provider: "codex"` 扩为 `"codex" | "claude"`；
- 引入共用 ACP client 和 runtime registry；
- 通过 `claude-agent-acp` 创建、加载、恢复和运行 Claude Session；
- 支持流式文本、工具状态、取消、知情审批、刷新和服务重启恢复；
- 完成具名 Agent 等待态、失败后显式重试、安全 Markdown/代码复制和
  用户上滚保护；
- 用真实 Claude 在隔离 Workspace 完成验收。

Delivery A 期间 Codex 继续走 raw App Server，仅作为迁移期兼容。

### 3.2 Delivery B：Codex ACP migration

- 用同一 ACP runtime 驱动 `codex-acp`；
- 对 Codex 与 Claude 运行同一套参数化 Provider 合约测试；
- 验证已有 Codex Thread ID 能通过 ACP `session/load` 读取并继续；
- 达到 raw 栈能力等价后删除 raw Codex client、adapter 和诊断分支；
- 用真实 Codex 在隔离 Workspace 完成验收。

无法无损恢复现有 Codex Session 时，Delivery B 不得删除 raw 栈，也不得宣称
完成；必须先解决迁移兼容性。

### 3.3 Delivery C：TaskMux session management

- 新建 Thread 时选择 Provider；
- 活跃与已归档列表；
- 切换、重命名、归档、恢复；
- Provider badge、状态与更新时间；
- 归档后释放 Provider 运行资源，但保留 Session 历史和 identity。

## 4. 终态架构

```text
InteractionThread
└── AgentExecution
    ├── provider: codex | claude
    └── externalSessionId
             │
             ▼
ProviderRuntimeRegistry
├── codex  → AcpRuntime → codex-acp
└── claude → AcpRuntime → claude-agent-acp
```

### 4.1 ProviderRuntimeRegistry

Registry 按 Provider 保存独立的 `AcpRuntime`。它负责：

- 延迟启动对应 ACP agent；
- 完成 initialize 与能力协商；
- 向 InteractionService 提供 Provider-neutral adapter；
- 对单个 Provider 执行有预算的重启；
- 报告 Provider 可用性，不产生全局 degraded lock。

Registry 不保存 Thread 或 Execution 状态，不决定 UI 选择，也不在 Provider
之间自动降级。

### 4.2 AcpRuntime

每个 runtime 拥有一个子进程、一个 ACP connection 和多个 Session 的订阅。
Provider 专用配置仅包括二进制、环境、诊断标签及 allow-listed capabilities。

TaskMux 启动时要求 Provider 至少支持：

- `session/new`；
- `session/load`；
- `session/resume`；
- `session/close`；
- `session/delete`（只用于尚未对用户可见的创建失败补偿）；
- `session/prompt` 与 `session/cancel`；
- `session/update`；
- `session/request_permission`。

缺失必需能力时，只禁用该 Provider 的新建和恢复操作，并显示结构化诊断；
另一 Provider 继续可用。

### 4.3 InteractionService

InteractionService 仍是 Thread、Execution、ActiveTurn 和 Approval 的生命周期
owner。它从 Repository 读取 Execution 的 Provider 与 Session identity，再向
Registry 解析 runtime。浏览器不能提交或修改 `externalSessionId`。

ActiveTurn 继续按 `executionId` 隔离。ACP 层不得重新引入全局
`activeConversationId` 或“任意会话运行时禁用所有 Composer”的假设。

## 5. 数据模型与 API

### 5.1 数据模型

```ts
type Provider = "codex" | "claude"

type InteractionThreadSummary = {
  id: string
  title: string
  status: "idle" | "running" | "failed" | "interrupted"
  archivedAt: string | null
  executions: AgentExecutionSummary[]
  createdAt: string
  updatedAt: string
}

type AgentExecutionSummary = {
  id: string
  threadId: string
  agentId: string
  displayName: string
  provider: Provider
  status: "idle" | "running" | "failed" | "interrupted"
  createdAt: string
  updatedAt: string
}
```

完整历史投影中的 Agent Turn 还可以携带归一化活动摘要：

```ts
type TurnActivity = {
  id: string
  kind: "tool"
  label: string
  status: "running" | "completed" | "failed" | "declined"
}

type InteractionMessageTurn = {
  id: string
  executionId: string
  agentId: string
  displayName: string
  role: "user" | "assistant"
  text: string
  status: "pending" | "completed" | "interrupted" | "failed"
  activities: TurnActivity[]
}
```

活动必须归属于具体 Assistant Turn，不能只保存在 Execution 级的“当前工具”
数组。历史加载必须恢复已完成活动摘要；如果真实 Provider 的 `session/load`
无法稳定重放并关联工具历史，实现必须持久化归一化活动投影，而不是在刷新后
静默丢失 C 模块。

SQLite 的 `interaction_thread` 增加可空 `archived_at`；`agent_execution.provider`
约束扩展为 `codex | claude`。`external_session_id` 只存在于 server-side stored
type，公共 DTO 不暴露其写入口。

历史消息由持久 Provider Session 通过 ACP `session/load` 重放。TaskMux 不使用
`no-session-persistence`，不设置 Session TTL，也不在归档时删除 Provider
Session。

### 5.2 HTTP API

```text
GET   /api/providers
POST  /api/threads                    { provider }
GET   /api/threads?view=active|archived
GET   /api/threads/:threadId
PATCH /api/threads/:threadId          { title }
POST  /api/threads/:threadId/archive
POST  /api/threads/:threadId/restore
```

- `provider` 只在创建时接受，之后所有更新请求都拒绝它；
- Provider 列表返回 `available | unavailable` 与 sanitized diagnostic，供新建
  选择器使用；全局 health 不代替逐 Provider 状态；
- title 必须去除首尾空白、非空并限制 code point 长度；
- 归档运行中 Thread 返回 `409 thread_running`；
- restore 幂等，重复恢复保持成功；
- 默认列表不返回归档 Thread；
- create 使用 client request identity 防止网络重试生成两个 Provider Session。

## 6. 生命周期

### 6.1 创建

1. 校验 Provider 可用且具备必需 ACP capabilities；
2. 通过 ACP 创建持久 Session；
3. 在单个 SQLite transaction 中创建 Thread 与默认 Execution；
4. 返回公共 DTO。

若数据库提交失败，runtime 必须 best-effort close/delete 新 Session 并记录
sanitized orphan diagnostic。客户端在 HTTP 成功前不得把乐观 Thread 当成已持久化。

### 6.2 加载与恢复

- 页面需要完整历史时使用 `session/load`；
- 已有历史、只需重新绑定运行连接时优先 `session/resume`；
- `session/load` 的重放事件必须与当前 live turn 分 epoch，不能重复渲染；
- Provider 报 Session 不存在时保留 Thread 元数据并显示 `session_unavailable`，
  禁止静默创建替代 Session。

### 6.3 重命名

重命名只改变 TaskMux Thread title，不改变 Provider Session title。首版不自动
双写 Provider，避免 Provider 能力差异污染公共契约。

### 6.4 归档与恢复

- 只有非 running Thread 可以归档；
- 归档 transaction 写入 `archived_at`，随后调用 `session/close` 释放 runtime
  资源；close 失败不回滚用户的归档选择，而是记录可重试诊断；
- 恢复只清空 `archived_at`，真正打开会话时再 load/resume；
- 归档不是删除，所有元数据和 Provider Session identity 永久保留。

## 7. 事件与审批

公共事件 envelope 保持：

```ts
type InteractionEventEnvelope = {
  threadId: string
  executionId: string
  agentId: string
  clientRequestId?: string
  seq: number
  payload: InteractionEvent
}
```

ACP `session/update` 映射为文本增量、工具状态与终态。Adapter 必须按 Session
和当前 operation 归属事件；迟到、重复和错误 Session 的事件不得结束新的 Turn。
公共 `tool_status` 事件必须携带 `turnId`，使同一 Execution 内连续 Turn 的活动
不会串线。`agent_thought_chunk` 只更新受控的运行存活状态，其文本在 Adapter
边界丢弃，不进入公共事件 envelope。

审批使用 ACP request/response 语义：

- 命令显示命令、cwd、截断标记；
- 文件变更显示目标路径与 bounded diff；
- 未知工具显示安全通用卡片；
- decline、cancel、超时和 transport failure 都最多 settle 一次；
- 未决审批在 Turn 结束或 runtime 崩溃时统一取消。

## 8. 故障与恢复

1. 一个 Provider 子进程退出只影响映射到它的活动 Execution。
2. 意外 Provider 退出使受影响 Turn 进入 `failed`；用户取消或正常停机使其
   进入 `interrupted`。两条路径都释放所有审批与锁。
3. Runtime 按预算自动重启，但绝不自动重发用户消息，避免命令或写文件重复。
4. 重启成功后按需 load/resume 原 Session；失败保留 Thread 与可操作错误。
5. 不允许 Claude Session 自动降级到 Codex，反之亦然。
6. Provider authentication、binary missing、version mismatch、quota、transport lost
   使用稳定的 TaskMux 错误码；raw stderr 和凭据不进入浏览器。
7. 服务关闭时先停止接收新 Turn，取消/settle 未决审批，再关闭两个 runtime。

## 9. 安全边界

- ACP 文件读写和 terminal 只能访问 canonicalized Workspace roots；symlink、
  junction 或 mount escape 必须 fail closed；
- 不连接 Clowder AI 生产 Redis 6399，TaskMux 当前也不引入 Redis；
- 本地 dev server 不使用 3003/3004；
- 命令、Diff、Provider stderr 和认证信息不得写入普通应用日志；
- Provider Session identity 只允许 server 读取；
- 所有真实 Provider 验收使用一次性隔离 Workspace，不接触生产用户数据；
- 不启用 bypass permissions 作为默认或自动测试配置。

## 10. UI 契约

### 新建

“新建会话”打开一个轻量 Provider 选择：Codex 或 Claude。不可用 Provider
显示具体诊断且不可选择；不隐藏错误，也不把它替换为另一个 Provider。

### 侧栏

- 默认显示活跃会话；
- 每行显示 title、Provider badge、状态和更新时间；
- 提供“已归档”入口；
- running 状态只锁定对应 Execution 的 Composer。

### 管理动作

- rename 使用 inline form 或菜单，不增加独立设置页；
- archive 在运行时禁用并解释原因；
- restore 后回到活跃列表；
- 首版没有永久删除入口。

### 单 Agent 对话体验

- 发送后立即显示用户消息和具名 Agent 等待气泡，不等待 Provider 首 token；
- Markdown/GFM 与围栏代码块安全渲染，raw HTML 不执行，代码可复制；
- 用户停留底部时跟随流式内容，主动上滚后不抢夺阅读位置；
- 失败、取消、重连和显式重试都有独立状态，重试生成新的 request identity，
  不重复旧的乐观消息。

### 对话与活动的视觉层级

界面采用 co-creator 批准的 `B × C` 双层投影：

1. **B 是回答层。** 用户消息与 Agent 最终回答保持自然的对话气泡；纯聊天
   完成后不得残留空活动卡或把长回答包装成运行仪表盘。
2. **C 是活动层。** 本轮真实发生工具调用时，在对应 Agent 气泡上方增加
   活动模块；模块与该轮回答共同归属于同一 Turn，不得漂浮到全局状态区。
3. 活动模块只显示有事件依据的工具名称、状态与可用结果摘要。详细命令、
   bounded Diff、错误和审批继续进入按需展开层，不默认淹没对话。
4. 运行时活动模块展开；Turn 完成后折叠为简短摘要。没有工具调用的 Turn
   完成后只保留 B 气泡。
5. `running`、`completed`、`failed`、`declined` 与等待审批不能只靠颜色区分，
   必须同时提供文字或图标语义。

### Thinking 与等待态

Thinking 是本轮 Agent 的临时运行态，不是聊天消息，也不是第二张永久卡片：

- 发送后在 200ms 内创建具名 Agent 占位气泡；若 400ms 内已有首个有效事件，
  不额外闪现 Thinking 文案；超过 400ms 才显示“正在思考”。
- Provider 没有可靠进度事件时，副文案只能是“等待模型响应”，不得由前端
  编造“正在检索”“正在比较方案”等阶段。
- 第一条工具事件到达后，Thinking 进入 C 活动模块并由真实工具状态驱动；
  第一条文本增量到达后，B 气泡开始流式回答。
- 纯聊天完成后移除临时 Thinking；发生过工具调用的 Turn 保留折叠活动摘要。
- ACP `agent_thought_chunk` 表示内部 reasoning。V0 不把其文本发送到浏览器、
  写入普通日志或持久化为消息；它最多作为运行仍存活的信号。未来只有在
  Provider 契约明确标注为 user-facing summary 时，才能另行设计可选摘要层。
- 原始思维链不是审计依据。可验证依据来自工具事件、文件/命令/Diff、审批、
  测试结果和最终决策说明。

### Composer 与滚动坐标系

页面主体必须使用三个互不覆盖的布局行：Header、可滚动消息视口、Composer。
消息视口使用剩余高度并自行滚动；Composer 位于正常布局流的第三行，不得用
`sticky`、`fixed` 或绝对定位侵入消息视口。桌面和窄屏下，最后一条消息都必须
能完整滚动到 Composer 上方。

自动滚动仍遵循用户意图：停留底部时跟随流式内容；用户主动上滚后不抢夺位置；
Thinking、工具状态和折叠摘要的高度变化也必须经过同一 near-bottom 判定。

## 11. 测试策略

### 11.1 共用 ACP contract suite

同一套 fake ACP agent 合约分别参数化运行 `codex` 和 `claude`：

- initialize 与 capability rejection；
- new/load/resume/close；
- streaming text、tool、approval、cancel、terminal；
- duplicate/late/out-of-session events；
- process exit、restart budget、pending approval cleanup；
- Session 不存在与认证失败。

### 11.2 Repository / Service / API

- provider 与 archivedAt migration 幂等、事务回滚；
- create retry 只生成一个 Thread/Session；
- Provider 不可变且浏览器不能写 Session identity；
- 同 Provider 与跨 Provider 的多个 Execution 可并行；
- 一个 runtime 崩溃不污染另一 runtime；
- running Thread archive 返回 409；
- rename、archive、restore 和列表过滤正确。

### 11.3 Client / E2E

- Provider chooser 与 disabled diagnostic；
- 不同 Provider 会话切换时 live state 不串线；
- pending bubble、断线恢复与 history replay 不重复；
- Markdown/代码复制、raw HTML 禁用和用户上滚保护；
- 纯聊天完成后只有 B 气泡；工具 Turn 的 C 活动模块位于对应 Agent 气泡上方，
  并在完成后折叠；
- 使用 fake timers 验证 400ms Thinking 阈值、首事件状态转换与纯聊天完成后清理；
- `agent_thought_chunk` 文本不进入公共 SSE、DOM、浏览器状态或普通日志；
- 完成的工具活动在刷新和服务重启后仍恢复到原 Assistant Turn；
- 在 1280×720 与 390×720 视口断言消息视口和 Composer 几何边界不重叠；
- 失败重试生成新 request identity，且只出现一个新的乐观消息对；
- rename、archive、restore 的乐观状态只在 HTTP 接受后持久；
- 浏览器刷新和服务重启后恢复同一 Session；
- 两个 Provider 会话并发时各自可取消和审批。

### 11.4 真实验收

在一次性 Workspace 中分别对 Claude 与 Codex 完成：

- 至少十轮短对话；
- 慢首 token、长流式回复、取消、失败后显式重试；
- 一次命令审批和一次文件变更审批；
- 页面刷新、服务重启与 Session 恢复；
- Provider 进程重启后继续原 Session。

记录 first-visible-feedback、first-token、terminal latency 和 sanitized transport
outcome。fake E2E 不能替代真实 Provider 验收。

## 12. 验收标准

- AC-1：新建时可选择 Codex 或 Claude，成功后 Provider 永久绑定该 Execution。
- AC-2：Claude ACP 多轮、流式、取消、审批和恢复通过真实验收。
- AC-3：Codex ACP 达到 raw 栈能力等价，旧 Session 可继续，raw 栈被删除。
- AC-4：两个 Provider 的会话可以同时运行，状态、事件和审批不串线。
- AC-5：单个 Provider 崩溃不阻塞另一 Provider，且不会自动重放副作用。
- AC-6：创建、列表、切换、重命名、归档和恢复均持久化且可恢复。
- AC-7：归档不删除历史；运行中 Thread 不可归档。
- AC-8：刷新、服务重启和 runtime 重启都继续原 Provider Session。
- AC-9：公共 DTO 不暴露 Provider Session 写入口，文件/terminal 保持 Workspace 边界。
- AC-10：所有单元、组件、E2E、typecheck、build 和真实 Provider 门禁通过。
- AC-11：三个交付分别完成独立跨个体 Review，不 self-review。
- AC-12：历史设计明确 superseded，仓库只有本文件作为活跃产品真相源。
- AC-13：单 Agent 首版保留即时等待、Markdown/代码复制、跟随滚动、取消、
  失败重试和知情审批，不因 Provider/会话管理扩展而退化。
- AC-14：纯聊天使用 B 气泡；只有真实工具事件产生 C 活动模块，模块始终位于
  所属 Agent 气泡上方，完成后折叠、刷新后恢复且不污染其他 Turn。
- AC-15：Thinking 遵守 200ms 占位与 400ms 文案阈值，不编造进度；原始
  `agent_thought_chunk` 不进入浏览器、普通日志或消息持久层。
- AC-16：桌面与窄屏的 Composer 均不覆盖消息视口，最后一条消息可完整滚动到
  Composer 上方。

## 13. 明确不做

- 同一 Thread 内第二个 Agent、`@Agent` 路由或 Handoff；
- 运行中切换 Provider；
- Provider 自动 fallback；
- 外部 CLI Session 扫描或导入；
- 永久删除、搜索、标签、置顶、文件夹；
- ACP session fork、goal、elicitation、subagent transcript 的产品 UI；
- 云端托管 Agent、API key 管理界面或计费功能。

## 14. 外部证据审计

| Claim | 来源 | Verdict | Provenance |
|---|---|---|---|
| ACP 已稳定 `session/resume` | Agent Client Protocol 官方公告，2026-04-22 | use | 一手协议文档；当前 ACP 适用 |
| Claude CLI 支持 stream-json 与按 ID resume | Anthropic CLI 官方文档 + 本机 Claude Code 2.1.241 help | use | 一手文档与本机验证 |
| `claude-agent-acp` 基于官方 Claude Agent SDK 并提供权限/Session 映射 | ACP 项目 README + 本机 0.69.0 包源码 | use-with-caveat | ACP/Zed 维护，非 Anthropic 稳定性承诺 |
| `codex-acp` 使用 Codex App Server thread ID 实现 load/resume | ACP 项目 README + 本机 1.4.0 包源码 | use-with-caveat | ACP 项目实现；仍需真实旧 Session 迁移验收 |

## 15. 收敛检查

1. 否决理由 → ADR：旧 ADR“V0 冻结 ACP”被 co-creator 的新决策取代，状态改为 superseded。
2. 踩坑教训 → 后续 completion 时记录：Provider 抽象与 Multi-Agent 价值不可混为一谈；本次选择 ACP 是终态维护成本决策，不把它宣称为 Multi-Agent 已完成。
3. 操作规则 → 无新增跨项目规则；现有 Vision Guardian、TDD、真实 Provider 验收和独立 Review 足够。
