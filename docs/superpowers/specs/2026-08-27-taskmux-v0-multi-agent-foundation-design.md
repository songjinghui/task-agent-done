---
feature_ids: [taskmux-v0-interaction-kernel]
topics: [taskmux, single-agent, multi-agent, conversation, ux, architecture]
doc_kind: spec
created: 2026-08-27
status: superseded
approved: 2026-08-27
superseded_by: docs/superpowers/specs/2026-08-30-taskmux-acp-providers-and-session-management-design.md
supersedes:
  - docs/superpowers/specs/2026-08-23-taskmux-text-workbench-v1-design.md
source_threads:
  - thread_msyk6u7unsyd1mh3
  - thread_mtbh922hu8iqtyum
---

# TaskMux V0 单 Agent 交互内核与 Multi-Agent 演进设计

## 1. 产品契约

TaskMux 的终态是一个本地 Agent 交互系统：用户在同一工作空间中与一个或多个具名 Agent 对话，能看见每个 Agent 的身份、运行状态、输出和交接关系。

V0 只配置一个 Agent、连接一个真实 Provider，并把单 Agent 多轮对话做到可日常使用。V0 不是独立的 Codex 网页客户端；它是 Multi-Agent 系统在 `N = 1` 时的完整纵向切片。增加第二个 Agent 时，不得重写 Thread、Execution、事件协议、持久化关系或消息渲染主结构。

当前 `feature/taskmux-text-v1` 的 Codex App Server、SSE、恢复、审批和测试成果全部保留。ACP 双后端迁移冻结，不进入 V0。

## 2. 已确认决策

1. 产品坐标是“人和 Agent 的交互空间”，不是 Provider 切换器、CLI 管理器或任务看板。
2. V0 只有一个 Agent，但领域和事件模型从第一天支持一个 Thread 下存在多个 Agent Execution。
3. Provider 原生 Session 是执行载体，不等于业务 Thread，也不等于 Agent Execution。
4. V0 继续使用 Codex App Server；不引入 Claude、ACP、工作流引擎或自由 Agent 群聊。
5. 历史 Session 导入、Task 管理和跨模型 Review 保留为后续产品层，不阻塞交互内核。
6. V0 优先完成真实对话体验；fake E2E 不能替代真实 Provider 验收。
7. 命令和文件修改审批必须让用户看见足够的信息后再决定，不能只有“批准/拒绝”两个盲按钮。

## 3. 范围

### 3.1 V0 必须完成

- 单个具名 Agent 的多轮文本对话；
- 用户消息的即时乐观呈现和 Assistant 等待态；
- 流式增量、慢响应反馈、取消、失败后的显式重试；
- Markdown/GFM 文本、围栏代码块和复制操作；
- 跟随式自动滚动，用户主动上滚后不抢夺位置；
- 展示具体命令或文件变更摘要的知情审批；
- 页面刷新、事件流重连和服务重启后的历史恢复；
- Thread、Agent Execution、Provider Session 三种身份的稳定区分；
- 不同 Execution 的独立 turn lock；V0 只有一个 Execution，但不保留全局单 Turn 假设；
- 旧 `conversation` 数据的无损迁移。

### 3.2 V0 明确不做

- 第二个 Agent 或第二种 Provider；
- Codex/Claude 启动时切换；
- ACP 协议迁移；
- Agent 自动选择、编排、投票或开放式互聊；
- Task、Review、Handoff、Artifact 的产品 UI；
- 导入 TaskMux 外创建的原生 Session；
- 图片、语音和附件；
- 模型市场、Skill 市场和通用工作流编辑器；
- 完整语法高亮。V0 的代码块只要求安全展示与复制。

## 4. 终态领域模型

```text
InteractionThread
└── AgentExecution [1..N]
    └── Provider Session identity
```

### 4.1 InteractionThread

用户可见的持续对话容器。它拥有标题、创建时间和更新时间，但不保存 Provider 专用字段。Thread 状态由所含 Execution 状态投影得到，不单独维护一份可漂移状态。

### 4.2 AgentExecution

一个具名 Agent 在 Thread 中的独立运行单元。V0 每个 Thread 恰好一个 Execution；数据库和 API 不写死这个基数。

```ts
type AgentExecution = {
  id: string
  threadId: string
  agentId: string
  displayName: string
  provider: "codex"
  externalSessionId: string
  status: "idle" | "running" | "failed" | "interrupted"
  createdAt: string
  updatedAt: string
}
```

`agentId` 是产品身份，`provider` 是运行载体，`externalSessionId` 是 Provider 原生会话身份，三者不可互换。

### 4.3 消息与实时事件

历史消息和实时事件都必须标明来源 Execution。V0 的默认 Agent 可显示为 `Codex`，但 UI 不再硬编码 `Assistant` 或从 Provider 类型猜身份。

```ts
type InteractionEventEnvelope = {
  threadId: string
  executionId: string
  agentId: string
  seq: number
  payload: InteractionEvent
}
```

消息正文仍可由 Provider transcript 恢复；V0 不提前建立完整 SQL transcript。应用层必须保留来源 Execution 和时间顺序，使后续合并多 Agent 时间线时只增加投影，不替换公共协议。

## 5. 组件边界

### InteractionService

- 创建 Thread 和默认 Execution；
- 按 `executionId` 管理发送、取消和审批；
- 把 Adapter 事件补齐 Thread、Agent 和 Execution 身份后发布；
- 不解析自然语言来决定工作流；
- 不持有全局唯一 `activeConversationId`。

### AgentAdapter

- 负责 Provider Session 创建、恢复、发送、取消和事件归一；
- 对外暴露 Provider-neutral 的事件和审批详情；
- 不修改 React Store；
- 未知工具必须以安全通用形态呈现，不能静默丢弃。

### Repository

- `interaction_thread` 保存 Thread 元数据；
- `agent_execution` 保存 Agent、Provider Session 和生命周期状态；
- 迁移现有 `conversation.codex_thread_id` 为默认 Codex Execution；
- 迁移必须幂等，已有标题、状态、时间戳和 Session ID 不丢失。

### React Client

- Store 以 `threadId + executionId` 管理 live state；
- 消息显示 Agent 名称；
- 当前只渲染一个 Execution，但数据结构允许同一 Thread 多个 Execution；
- Provider 专用类型和 raw JSON 不进入组件 Props。

## 6. 生命周期与不变量

### 6.1 状态对象普查

| 对象 | Lifecycle owner | 关键状态 |
|---|---|---|
| InteractionThread | Repository / InteractionService | 存在、归档（归档不在 V0 UI） |
| AgentExecution | InteractionService | idle、running、failed、interrupted |
| ActiveTurn | InteractionService 内存态 | starting、running、cancelling、terminal |
| ApprovalRequest | AgentAdapter + InteractionService | pending、accepting、declining、expired、terminal |
| Client live projection | React reducer | derived from HTTP ownership + SSE events |

### 6.2 不变量

- INV-1：每个 AgentExecution 只绑定一个 Provider Session identity；identity 不暴露给浏览器写入。
- INV-2：一个 Thread 可以有多个 Execution；V0 创建流程只创建一个。
- INV-3：Turn lock 只作用于一个 Execution，不阻塞其他 Execution。
- INV-4：只有 lifecycle owner 可以结束 Execution 的 running 状态；迟到事件不能复活已结束 Turn。
- INV-5：Thread 状态是 Execution 状态的纯投影，不独立持久化。
- INV-6：刷新或重启不会重复用户消息、Assistant 消息或工具记录。
- INV-7：审批详情只发送给本地浏览器，不进入日志、标题或错误消息。
- INV-8：用户拒绝或审批过期后，工具和 Turn 都能到达明确终态。
- INV-9：迁移后所有旧 Conversation 恰好对应一个 Thread 和一个默认 Codex Execution。
- INV-10：所有用户可见 Thread 和 Execution 元数据默认永久持久化，无 TTL。

## 7. 对话体验

### 7.1 发送与等待

发送后立即显示用户消息和一个带 Agent 名称的等待气泡。HTTP 尚未确认、Provider 已接受、正在流式输出和正在取消是不同状态；界面不能在首个文本增量前保持空白。

慢响应期间显示持续时间和可取消动作。SSE 断开时保留已接受消息，并显示“正在恢复实时连接”，不制造第二条乐观消息。

### 7.2 文本与代码

使用 `react-markdown` 与 `remark-gfm` 渲染 Markdown；禁用 raw HTML。围栏代码块保留语言标签并提供复制按钮，不引入完整语法高亮依赖。

自动滚动只在用户接近底部时跟随新内容；用户上滚阅读历史后显示“回到底部”，不强制跳转。

### 7.3 审批

命令审批展示完整命令、工作目录和风险提示；文件审批展示目标文件及变更摘要，能够提供 Diff 时使用可展开纯文本 Diff。所有内容作为文本渲染，禁止注入 HTML。

详情大小必须有上限；超限时明确提示截断。审批详情不写入普通应用日志。

### 7.4 失败与恢复

失败消息显示安全的 Provider 错误和“重试上一条”动作。重试创建新的 client request identity，不复用已终止 Turn。取消后保留用户消息并标注本轮已取消。

真实 smoke 使用“无事件 inactivity timeout + overall deadline”，并把 Provider 传输重试、模型输出和最终终态区分记录。固定 60 秒内没有完成不再被直接等同于协议失败。

## 8. 测试策略

### 8.1 Repository 与迁移

- 从真实 v1 schema fixture 迁移；
- 重复执行迁移无重复 Execution；
- 中途失败事务回滚；
- 旧 running 状态启动后变为 interrupted；
- Provider Session ID 唯一约束保持。

### 8.2 Service 与事件

- 同一 Execution 双发返回冲突；
- 两个不同 Execution 可以各自运行；
- 迟到、重复和乱序终态事件不污染新 Turn；
- approval accept/decline/expire 都释放所有权；
- Adapter 崩溃只终止其拥有的 active turns。

### 8.3 Client

- 等待气泡在首 token 前可见；
- Markdown、代码复制和 raw HTML 禁用；
- 自动滚动与用户上滚保护；
- informed approval 不丢命令或文件目标；
- 重试不重复乐观消息；
- 重连、切换 Thread 和迟到 HTTP/SSE 的竞态测试。

### 8.4 真实验收

- 隔离 Workspace 中完成至少十轮短对话；
- 覆盖首 token 慢、流式长回复、取消、失败重试和一次知情审批；
- 刷新页面和重启服务后继续原 Provider Session；
- 记录 first-visible-feedback、first-token、terminal latency 和传输回退，不把单次演示成功当成稳定结论。

## 9. 验收标准

- AC-1：发送后 200ms 内出现用户消息和 Agent 等待态，不依赖 Provider 首 token。
- AC-2：流式文本无明显重复、丢失或乱序，Markdown 与代码块安全可读。
- AC-3：自动滚动不打断用户阅读历史。
- AC-4：用户能看见具体命令或文件变更信息后再批准或拒绝。
- AC-5：取消、失败、重试和 SSE 重连都有明确可恢复状态。
- AC-6：刷新和服务重启后能恢复历史并继续原 Provider Session。
- AC-7：公共 DTO、事件、Store 和数据库均区分 Thread、AgentExecution 与 Provider Session。
- AC-8：Turn ownership 按 Execution 隔离，不保留全局单 Turn 假设。
- AC-9：旧 Conversation 数据无损、幂等迁移。
- AC-10：fake 单元/E2E、生产构建和真实 Codex 验收全部通过。
- AC-11：V0 diff 不包含 ACP、Claude 或 Provider selector 实现。
- AC-12：所有历史 V1 文档明确指回本设计，仓库只有一个活跃产品真相源。

## 10. 后续演进

V0 通过后再设计 V1。推荐的第一种 Multi-Agent 形态是：同一 Thread 中用户显式选择或 `@` 一个具名 Agent，Agent 通过结构化 Handoff 把上下文交给另一个 Agent。V1 需要单独确认共享时间线、路由、终止和冲突语义；本设计不提前实现。

Session 导入和 Task 管理作为 InteractionThread 之上的连续性层恢复，不再与底层 Agent Execution 混为同一对象。

## 11. 收敛检查

1. 否决理由 → ADR？有：否决“先扩 ACP 双后端等于推进 Multi-Agent”；待本 spec 批准后补轻量 ADR。
2. 踩坑教训 → lessons-learned？有：多份 V1 文档并存导致实现按局部 spec 漂移；待实际修正完成后归档。
3. 操作规则 → 指引文件？没有新增跨项目规则；现有愿景守护和单一真相源规则足够。
