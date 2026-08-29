---
feature_ids:
  - taskmux-v0-interaction-kernel
  - taskmux-acp-providers
  - taskmux-session-management
topics: [taskmux, acp, codex, claude, sessions, multi-agent, architecture]
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

SQLite 的 `interaction_thread` 增加可空 `archived_at`；`agent_execution.provider`
约束扩展为 `codex | claude`。`external_session_id` 只存在于 server-side stored
type，公共 DTO 不暴露其写入口。

历史消息由持久 Provider Session 通过 ACP `session/load` 重放。TaskMux 不使用
`no-session-persistence`，不设置 Session TTL，也不在归档时删除 Provider
Session。

### 5.2 HTTP API

```text
POST  /api/threads                    { provider }
GET   /api/threads?view=active|archived
GET   /api/threads/:threadId
PATCH /api/threads/:threadId          { title }
POST  /api/threads/:threadId/archive
POST  /api/threads/:threadId/restore
```

- `provider` 只在创建时接受，之后所有更新请求都拒绝它；
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
