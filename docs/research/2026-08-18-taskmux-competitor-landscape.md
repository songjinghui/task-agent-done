---
feature_ids: [taskmux-product-research]
topics: [taskmux, competitors, coding-agents, session-management]
doc_kind: research
created: 2026-08-18
---

# TaskMux Competitor Landscape — Source-Level Quick Audit

**Date:** 2026-08-18
**Scope:** GitHub open-source projects adjacent to coding-agent session management, task orchestration, and cross-model review
**Method:** README discovery followed by source inspection at pinned commits; this is a targeted landscape audit, not an exhaustive market or trademark search.

## 1. Executive conclusion

TaskMux should **not** position itself as any of the following in isolation:

- a multi-provider coding-agent UI;
- an importer for existing CLI sessions;
- a task board that launches coding agents;
- a two-agent or cross-model code-review tool.

All four shapes already exist. The closest project, Codeg, combines session import and resume, multi-agent delegation, a task board, worktrees, diffs, Git, mobile access, and a broad coding workspace. The Pair already makes cross-provider Mentor/Executor review its central product.

The defensible TaskMux wedge is narrower:

> **TaskMux is a continuity layer for coding-agent work: it reconnects scattered native sessions to the goals they serve, shows what needs attention next, and lets the user request an independent review without replacing the original CLI workflow.**

The central domain distinction is:

```text
Task = a durable human goal
Session = a native conversation record

0..n Sessions  →  0..n Tasks
unassigned Session is valid
one Task may span models, days, and unrelated positions in CLI history
```

For the interview release, the implementation can still constrain each Session to one confirmed primary Task while keeping the link as an independent entity. The product promise is goal continuity, not autonomous task execution.

## 2. Closest projects

### 2.1 Codeg — closest direct competitor

- Repository: [xintaofei/codeg](https://github.com/xintaofei/codeg)
- Inspected commit: `9d716876af1bd859d041c442f4bc295c237413f9`
- Snapshot: 2,799 stars, 353 forks, Apache-2.0, active on 2026-08-18.

What the source confirms:

- Codeg scans multiple local agent stores through provider parsers and imports selected sessions into a unified conversation index. Imported rows retain the provider `external_id`, are refreshed from the native transcript, and are marked `pending_review`. See [import_service.rs](https://github.com/xintaofei/codeg/blob/9d716876af1bd859d041c442f4bc295c237413f9/src-tauri/src/db/service/import_service.rs).
- Its README explicitly promises existing session import and resume across supported agents, along with cross-agent `@` delegation. See [README.md](https://github.com/xintaofei/codeg/blob/9d716876af1bd859d041c442f4bc295c237413f9/README.md#sessions-files-and-git).
- It has a real work-task state machine from `todo` through `running`, `awaiting_input`, `review`, `merging`, and `done`. A WorkTask owns an optional **single current** `conversation_id`; the schema does not expose a Task–Session link collection. See [work_task.rs](https://github.com/xintaofei/codeg/blob/9d716876af1bd859d041c442f4bc295c237413f9/src-tauri/src/db/entities/work_task.rs).

What not to copy:

- building a general IDE/workspace;
- matching its provider count;
- agent delegation through one conversation;
- headless task execution through worktree creation and automatic merge.

Remaining TaskMux distinction:

- Codeg's WorkTask is primarily an executable job and its current run is bound to one conversation. TaskMux's Task is a human goal that can collect multiple pre-existing and future Sessions.
- Codeg answers “run coding work in one workspace.” TaskMux should answer “where did this goal go, what evidence belongs to it, and what should I continue now?”
- TaskMux keeps session classification optional and foregrounds an Inbox; it should not force every quick learning question into a task pipeline.

### 2.2 Agent Deck — active-session terminal manager

- Repository: [asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck)
- Inspected commit: `2c97196d28b32214e7b2115ed312d3c1cbe5ffae`
- Snapshot: 744 stars, 122 forks, MIT, active on 2026-08-17.

What the source confirms:

- Agent Deck discovers and supervises agent sessions through tmux. Its durable database stores its own instances, groups, and provider session identifiers. See [discovery.go](https://github.com/asheshgoplani/agent-deck/blob/2c97196d28b32214e7b2115ed312d3c1cbe5ffae/internal/session/discovery.go) and [storage.go](https://github.com/asheshgoplani/agent-deck/blob/2c97196d28b32214e7b2115ed312d3c1cbe5ffae/internal/session/storage.go).
- It can scan and search Claude's native JSONL history, but disk discovery is explicitly not authoritative for binding a managed runtime session. See [global_search.go](https://github.com/asheshgoplani/agent-deck/blob/2c97196d28b32214e7b2115ed312d3c1cbe5ffae/internal/session/global_search.go) and [session-id-lifecycle.md](https://github.com/asheshgoplani/agent-deck/blob/2c97196d28b32214e7b2115ed312d3c1cbe5ffae/docs/session-id-lifecycle.md).

Remaining TaskMux distinction:

- Agent Deck's organizing primitive is the managed terminal session/group. TaskMux's organizing primitive is the durable goal and its evidence timeline.
- TaskMux must make previously scattered native sessions first-class records even if TaskMux did not launch them.
- Agent Deck does not supply TaskMux's Task–Session continuity model or an arbitrary cross-model review action.

### 2.3 The Pair — strongest cross-model review overlap

- Repository: [timwuhaotian/the-pair](https://github.com/timwuhaotian/the-pair)
- Inspected commit: `757039e45c010a1b78a45e94367f3ad18c18f542`
- Snapshot: 354 stars, 28 forks, Apache-2.0, active on 2026-08-11.

What the source confirms:

- The Pair runs a read-only Mentor and a write-capable Executor, supports provider mixing across Codex, Claude Code, Gemini, Kimi, and OpenCode, and restores its own interrupted runs from snapshots. See [README.md](https://github.com/timwuhaotian/the-pair/blob/757039e45c010a1b78a45e94367f3ad18c18f542/README.md) and [session_snapshot.rs](https://github.com/timwuhaotian/the-pair/blob/757039e45c010a1b78a45e94367f3ad18c18f542/src-tauri/src/session_snapshot.rs).
- Review is a mandatory role in a fixed Mentor → Executor → Mentor loop, not a review requested against any historical session or task.

Remaining TaskMux distinction:

- Do not claim that cross-model review itself is novel.
- TaskMux Review should be an optional operation on a selected Task, Session, or Git diff, with isolated inputs and a persisted ReviewJob.
- TaskMux remains useful before Review exists: finding, grouping, and resuming work is the primary loop.

### 2.4 AgentMux — broad agent operating environment

- Repository: [agentmuxai/agentmux](https://github.com/agentmuxai/agentmux)
- Inspected commit: `62c04302dfeb0b9b5b16158370a292e799803ca2`
- Snapshot: 14 stars, 1 fork, Apache-2.0, active on 2026-08-18; README labels it early alpha.

What the source confirms:

- AgentMux is an agent operating environment with multi-provider panes, inter-agent messaging, native memory, structured tool/diff views, and an App API. It deliberately owns durable session state and generally invokes provider CLIs one turn at a time. See [README.md](https://github.com/agentmuxai/agentmux/blob/62c04302dfeb0b9b5b16158370a292e799803ca2/README.md).
- It discovers provider histories and backfills provider session identifiers to preserve resume continuity. See [history/index.rs](https://github.com/agentmuxai/agentmux/blob/62c04302dfeb0b9b5b16158370a292e799803ca2/agentmux-srv/src/backend/history/index.rs) and [session_backfill.rs](https://github.com/agentmuxai/agentmux/blob/62c04302dfeb0b9b5b16158370a292e799803ca2/agentmux-srv/src/backend/session_backfill.rs).
- Its “attached task” concept is a liveness/status axis for long-running processes, not a durable human goal associated with several conversations. See [SPEC_ATTACHED_TASK_STATUS_AXIS_2026_08_02.md](https://github.com/agentmuxai/agentmux/blob/62c04302dfeb0b9b5b16158370a292e799803ca2/docs/specs/SPEC_ATTACHED_TASK_STATUS_AXIS_2026_08_02.md).

Remaining TaskMux distinction:

- TaskMux is not an operating environment and should not own provider state.
- TaskMux indexes native stores read-only, then layers human organization and review on top.
- A smaller Node.js/Web implementation makes the domain model visible in an interview instead of competing on terminal, browser, editor, identity, and swarm infrastructure.

### 2.5 Kirodex — polished thread workspace, not continuity across providers

- Repository: [thabti/kirodex](https://github.com/thabti/kirodex)
- Inspected commit: `fb9348c4fe4fac571c2e7e66b71b91e62c0b73bb`
- Snapshot: 76 stars, 13 forks, active on 2026-08-18; GitHub reports no SPDX license.

What the source confirms:

- Kirodex provides persistent independent agent threads, thread search, pinning, archiving, task lifecycle controls, split view, worktrees, and its own goal loop through Kiro CLI. See [README.md](https://github.com/thabti/kirodex/blob/fb9348c4fe4fac571c2e7e66b71b91e62c0b73bb/README.md).
- Its frontend uses “Task” and “Thread” for essentially the same conversation object; the local database persists Kirodex-created threads and messages. See [task-store-types.ts](https://github.com/thabti/kirodex/blob/fb9348c4fe4fac571c2e7e66b71b91e62c0b73bb/src/renderer/stores/task-store-types.ts) and [thread_db.rs](https://github.com/thabti/kirodex/blob/fb9348c4fe4fac571c2e7e66b71b91e62c0b73bb/src-tauri/src/commands/thread_db.rs).

Remaining TaskMux distinction:

- TaskMux separates goal from conversation rather than renaming a conversation “Task.”
- It targets historical sessions created outside itself and cross-provider review, neither of which is Kirodex's center.

## 3. Feature comparison

| Capability | TaskMux target | Codeg | Agent Deck | The Pair | AgentMux | Kirodex |
|---|---:|---:|---:|---:|---:|---:|
| Discover sessions created outside the app | Yes | Yes | Partial / provider-specific search | No evidence | Yes / provider history | No evidence |
| Resume native provider session | Yes | Yes | Yes for managed sessions | Restores Pair-owned runs | Yes | Restores own threads |
| Session may remain unassigned | Yes, explicit Inbox | Yes as conversation | Yes | Not relevant | Yes | Thread is the task |
| One durable human goal groups many sessions | **Core** | No explicit link collection | No | No | No | No |
| “What should I continue next?” across goals | **Core** | Workflow status / pending review | Runtime status | Pair run status | Pane/activity status | Thread/task status |
| Cross-provider independent review | Optional action | Possible through delegation | No built-in pipeline | **Core fixed workflow** | Composable messaging | No evidence |
| Owns/replaces coding environment | No | Yes, broad workspace | Owns tmux layer | Owns Pair runtime | Yes, broad environment | Yes, Kiro workspace |

“No” and “No evidence” mean the inspected commit and selected source paths did not expose the capability; they are not universal absence proofs.

## 4. Revised positioning

### Recommended tagline

> **A continuity and review layer for coding-agent work.**

### 30-second product explanation

> I use coding agents across many sessions, and one goal often gets split across several conversations that are no longer adjacent. TaskMux reads the native session stores without taking ownership of them, lets temporary sessions stay unclassified, and connects the sessions that do belong together to a durable Task. Its home screen is an attention queue: what is running, what is waiting, and what should be resumed next. When a change needs a second opinion, any Task or Session can be sent to a different model with isolated context for review.

### Product boundary

TaskMux is:

- a read-only index over native agent histories;
- a user-controlled goal and attention layer;
- a resume launcher;
- an optional cross-model review orchestrator.

TaskMux is not:

- an IDE;
- a terminal multiplexer;
- an autonomous Kanban executor;
- a fixed two-agent programming loop;
- a replacement persistence layer for provider sessions.

## 5. MVP consequences

The competitor audit changes priority:

1. **P0: many Sessions on one Task.** The Task detail page must show a cross-session timeline. Without this, TaskMux collapses into a smaller Codeg or Kirodex.
2. **P0: Session Inbox with no forced Task.** This is part of the product thesis, not cleanup UI.
3. **P0: attention queue.** The default view should answer which goal or session should be resumed, not merely list conversations.
4. **P0: source-preserving resume.** Show provider, native session ID, source health, and resume provenance so the boundary is inspectable.
5. **P1: review from an existing artifact.** Review must accept a selected Task/Session/diff; it must not require TaskMux to have generated the code.
6. **Cut before expanding:** generic editor, Git client, worktrees, mobile, provider marketplace, agent delegation, autonomous merge.

## 6. Name check

A targeted GitHub repository search found no obvious relevant project named exactly `TaskMux`. The name fits the domain: a Task multiplexes several Sessions and providers into one goal timeline. This is not a legal trademark or package-registry clearance; npm, domain, and trademark checks should happen immediately before public release.

## 7. Claim ledger

| Claim | Source type | Freshness / object | Verdict |
|---|---|---|---|
| Codeg imports and resumes native multi-provider sessions | Primary repository and source | commit `9d716876`, 2026-08-18 | use |
| Codeg WorkTask stores one current `conversation_id` rather than an explicit session collection | Primary entity schema | commit `9d716876` | use |
| Agent Deck centers managed tmux sessions and separately searches Claude history | Primary source and design doc | commit `2c97196d` | use |
| The Pair already owns the cross-provider reviewer/executor product shape | Primary README and runtime source | commit `757039e4` | use |
| The audited field lacks TaskMux's exact goal-to-many-sessions continuity loop | Five targeted primary-source audits | 2026-08-18 | use-with-caveat; not an exhaustive absence proof |
| No exact relevant TaskMux repository was found | Targeted GitHub search | 2026-08-18 | use-with-caveat; not trademark clearance |

**Provenance:** `[一手｜GitHub repository/source｜2026-08-18 pinned commits｜current OSS coding-agent projects｜use-with-caveat: targeted audit, not exhaustive market search]`
