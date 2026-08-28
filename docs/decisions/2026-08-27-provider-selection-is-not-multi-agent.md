---
feature_ids: [taskmux-v0-interaction-kernel]
topics: [taskmux, multi-agent, provider, acp, architecture]
doc_kind: decision
created: 2026-08-27
status: accepted
source_threads:
  - thread_msyk6u7unsyd1mh3
  - thread_mtbh922hu8iqtyum
---

# Provider 选择不等于 Multi-Agent 演进

## 决策

TaskMux V0 冻结 ACP 双后端迁移，继续使用已跑通的 Codex App Server。V0 的架构投资放在 `InteractionThread → AgentExecution[] → Provider Session`、按 Execution 隔离的运行所有权，以及真实单 Agent 对话体验上。

第二种 Provider 只有在同一 Thread 内出现第二个具名 Agent、独立 Execution 和明确交接语义时，才算 Multi-Agent 阶段的组成部分。启动时在 Codex 与 Claude 之间二选一，不计为 Multi-Agent 进展。

## 原因

原始愿景中的多 Agent 价值来自跨模型独立 Review 和协作，而不是后端可替换性。继续扩展 ACP 会增加 Provider 兼容面，却不会恢复已经从领域模型中消失的 Agent 身份、Execution、并发边界和 Handoff。

## 后果

- 保留现有 Codex 适配、恢复、SSE 和审批成果。
- V0 diff 不新增 ACP、Claude 或 Provider selector 实现。
- Provider-neutral 接口仍然保留，但不以第二后端证明抽象有效。
- V1 另行设计具名 Agent 路由、独立上下文和结构化 Handoff。
