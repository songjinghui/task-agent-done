---
feature_ids: [taskmux-historical-session-task-v1]
topics: [taskmux, sessions, tasks, product-history]
doc_kind: archived-spec
created: 2026-08-18
superseded_by: docs/superpowers/specs/2026-08-27-taskmux-v0-multi-agent-foundation-design.md
---

# TaskMux — V1 Self-use Plan

> Historical product direction. It is preserved for provenance and is not the current implementation truth.

**Status:** V1 scope confirmed; implementation intentionally paused
**Created:** 2026-08-18
**Updated:** 2026-08-20
**Project:** TaskMux
**V1 focus:** Session and Task management
**Implementation start:** Not authorized yet

---

## 1. V1 Decision

TaskMux V1 is a local workbench for finding, continuing, and organizing coding-agent work.

V1 treats **Task** and **Session** as equal first-class objects:

- Session answers: what conversation or execution record exists?
- Task answers: what goal is the user trying to complete?
- A Task may link to zero, one, or many Sessions.
- A Session may contribute to zero, one, or many Tasks.
- The link records contribution; it does not automatically drive Task state.

V1 does **not** include cross-model Review. Review remains a V1.1 design question until its entry point, input boundary, result placement, and role in the product are understood through actual use.

The V1 information architecture has three primary destinations:

```text
Home
Sessions
Tasks
```

Settings is a utility destination. There is no top-level Reviews page and no Review button, notification, timeline item, or ReviewJob placeholder in V1.

## 2. Goal

Build a local Coding Agent workbench that:

1. discovers existing Codex Sessions without modifying their native storage;
2. helps the user search, inspect, create, and continue Sessions;
3. manages durable Tasks independently from Sessions;
4. connects Tasks and Sessions through a user-controlled many-to-many contribution relationship;
5. restores TaskMux state reliably after restart.

The project is intentionally smaller than Codeg. Its purpose is to solve a real personal workflow problem and provide a focused environment for learning session indexing, local process management, stateful domain modeling, persistence, testing, and UI delivery.

## 3. Product Principles

1. **Task and Session are both first-class.** Neither is merely a property or child of the other.
2. **Many-to-many, not forced hierarchy.** A Task can aggregate several Sessions, and one Session can contribute to several Tasks.
3. **Contribution is evidence, not execution.** Completing a Session never completes linked Tasks automatically.
4. **Unlinked objects are valid.** A Task may exist before work begins; a temporary Session may remain unlinked forever.
5. **Native Session storage is read-only truth.** TaskMux indexes and resumes native sessions but does not migrate, rewrite, or delete them.
6. **Workspace is an authorization axis.** Task links do not expand the filesystem scope of a Session or Run.
7. **Manual control first.** V1 uses explicit user-created Task–Session links. AI association suggestions are deferred.
8. **Derived state stays derived.** Attention indicators are calculated from persisted facts instead of duplicated as mutable status.
9. **Local-first and single-user.** V1 does not introduce accounts, teams, or a cloud control plane.
10. **Page-first delivery, real-data acceptance.** UI flows may begin with isolated fixtures, but V1 is not complete until the core flows work with real local Codex Sessions.

## 4. V1 Pages

### 4.1 Home

Home is a continuation surface, not a reporting dashboard.

It contains:

- Sessions that are running, paused, interrupted, or recently active;
- Tasks that are in progress or blocked;
- the confirmed next action for each active Task;
- deterministic Needs Attention items;
- recent Task–Session linking and state changes;
- actions to import Sessions, create a Session, and create a Task.

Home gives Tasks and Sessions equal visual weight. It does not force every Session into a Task.

### 4.2 Sessions

The Sessions page contains:

- imported and TaskMux-created Codex Sessions;
- keyword search;
- filters for Workspace, source health, link state, time, and runtime state;
- Session details and native provenance;
- create and continue actions;
- linked Tasks and contribution summaries;
- link and unlink actions.

Unlinked Sessions remain visible and searchable. A filter may expose them, but V1 does not require a separate Inbox page.

### 4.3 Tasks

The Tasks page contains:

- Task list and status filters;
- create, edit, pause, complete, archive, and restore actions;
- confirmed next action;
- linked Sessions;
- a contribution timeline built from confirmed TaskSessionLinks;
- link and unlink actions.

Task details never imply that a linked Session was launched exclusively for that Task.

### 4.4 Settings

V1 Settings is limited to configuration required by the core flow:

- Codex CLI availability and detected version;
- native Session source health;
- local database location and health;
- manual rescan;
- diagnostic information needed to explain import or resume failures.

## 5. V1 Functional Scope

### 5.1 Session discovery and indexing

- Detect all locally available Codex Sessions that the V1 adapter can parse.
- Preserve `provider + nativeSessionId` as the stable unique identity.
- Read native metadata and transcripts without modifying the source.
- Support full scan and idempotent incremental refresh.
- Isolate corrupt or missing Sessions instead of failing the entire scan.
- Record source health and last indexed time.
- Keep tests on isolated, redacted fixtures rather than the operator's real Session store.

### 5.2 Session creation and continuation

- Start a new Codex Session for an explicitly selected Workspace.
- Continue an existing Session through its native identifier.
- Stream observable process output needed by the UI.
- Persist Run lifecycle facts.
- Recover stale running Runs as interrupted after application restart.
- Surface CLI-not-installed, incompatible-version, permission, launch, and non-zero-exit failures clearly.

### 5.3 Task management

- Create, edit, pause, complete, archive, and restore Tasks.
- Use the V1 states:

```text
todo | in_progress | blocked | done | archived
```

- Store a user-confirmed next action.
- Allow Tasks with no linked Sessions.
- Do not let imported Session content change Task state automatically.

### 5.4 Task–Session contribution links

TaskSessionLink is a real many-to-many relationship.

V1 fields:

- `taskId`
- `sessionId`
- `relation`: `work | reference`
- `contributionSummary` (optional, user-editable)
- `source`: `manual`
- `createdAt`
- `updatedAt`

V1 rules:

- `(taskId, sessionId)` is unique;
- a Task may have any number of links;
- a Session may have any number of links;
- linking does not change Task or Session lifecycle state;
- unlinking deletes only the link;
- deleting or archiving a Task never modifies or hides the native Session;
- missing native Session data does not erase the link or Task history.

### 5.5 Persistence

SQLite stores only TaskMux-owned projections and user state:

- Workspaces;
- Session index projections;
- Tasks;
- TaskSessionLinks;
- Runs;
- schema migrations and application metadata.

All user-visible Task, link, next-action, and Run history is persistent by default with no TTL.

## 6. V1 Domain Model

### Workspace

A detected or user-selected local project directory. Workspace is a discovery and execution boundary, not the parent of every Task.

### Session

A read-only projection of a native coding-agent conversation.

Suggested V1 fields:

- id
- provider
- nativeSessionId
- workspaceId (nullable)
- nativeCreatedAt / nativeUpdatedAt
- sourceHealth: `available | missing | corrupt`
- lastIndexedAt
- title / summary

Session does not contain `primaryTaskId`.

### Task

A user-managed goal with an independent lifecycle.

Suggested V1 fields:

- id
- title
- description
- status: `todo | in_progress | blocked | done | archived`
- confirmedNextAction (nullable)
- createdAt / updatedAt / completedAt (nullable)

Task does not own Session lifecycle or filesystem authorization.

### TaskSessionLink

The confirmed contribution relationship between Task and Session. It has no primary-parent semantics.

### Run

A process record for starting or continuing a Session.

Suggested V1 fields:

- id
- sessionId
- state: `queued | starting | running | completed | failed | interrupted`
- pid (nullable while running)
- startedAt / endedAt
- exitCode / failureReason

### Deferred domain objects

`ReviewJob`, Reviewer configuration, Review Case File, findings, and Review placement are explicitly outside V1.

## 7. Lifecycle Ownership and Invariants

| Object | Lifecycle owner | V1 rule |
|---|---|---|
| Native Session source | Codex CLI | TaskMux never writes or deletes it |
| Session projection | Session Indexer | Scan may upsert projection fields only |
| Run | Process Supervisor | Other modules cannot directly write runtime state |
| Task | Task Service and user actions | Session events cannot complete Tasks |
| TaskSessionLink | Association Service and user actions | Only confirmed manual links exist in V1 |

Core invariants:

- INV-01: Native Session data is always read-only.
- INV-02: `provider + nativeSessionId` is unique.
- INV-03: Repeated scans do not duplicate Sessions or links.
- INV-04: Unlinked Sessions and Tasks are valid.
- INV-05: Task and Session have independent lifecycles.
- INV-06: A Session may link to multiple Tasks, and a Task may link to multiple Sessions.
- INV-07: Session completion never implies Task completion.
- INV-08: Unlinking or archiving never modifies native Session data.
- INV-09: Workspace permissions are not broadened by Task links.
- INV-10: After restart, stale running Runs become interrupted.
- INV-11: Needs Attention is derived from persisted facts where possible.
- INV-12: User-created Tasks, links, and next actions persist with no TTL.

## 8. Acceptance Criteria

### Session flow

- AC-01: First launch discovers every locally available Codex Session supported by the adapter.
- AC-02: Repeated or concurrent scans do not create duplicate Sessions.
- AC-03: Missing or corrupt Sessions have explicit health states and do not stop the scan.
- AC-04: Users can search and filter Sessions by Workspace, time, state, and keyword.
- AC-05: Users can create a new Session for a selected Workspace.
- AC-06: Users can continue the correct native Session by its native identifier.
- AC-07: A failed or interrupted Run is visible and recoverable after restart.

### Task and association flow

- AC-08: Users can create, edit, pause, complete, archive, and restore Tasks.
- AC-09: A Task may exist with no Sessions, and a Session may remain unlinked.
- AC-10: One Task can link to at least two non-adjacent historical Sessions.
- AC-11: One Session can link to at least two Tasks.
- AC-12: Session completion does not automatically change either linked Task's status.
- AC-13: Unlinking or archiving a Task does not delete, modify, or hide its native Sessions.

### Product and reliability flow

- AC-14: Home shows actionable Sessions and Tasks without privileging one as the universal parent.
- AC-15: Restart preserves Tasks, links, next actions, Session projections, and Run history.
- AC-16: Core rules have unit and state-machine tests.
- AC-17: A real-browser E2E covers import, search, link, Task timeline, and continue.
- AC-18: A clean local setup can reproduce the documented V1 flow.

## 9. Demonstration Journey

The V1 acceptance demo is:

```text
Launch TaskMux
  → discover real Codex history
  → search and open an old Session
  → link that Session to two Tasks
  → open one Task and see multiple linked Sessions
  → continue the correct native Session
  → update the Task's next action manually
  → restart TaskMux
  → verify all TaskMux state is restored
```

This demo deliberately excludes Review.

## 10. Explicitly Out of Scope for V1

- Cross-model Review and ReviewJob persistence
- Review buttons, notifications, timelines, or standalone pages
- AI-generated Task association or automatic Task state changes
- Importing historical Sessions from providers other than Codex
- Three or more active Agent providers
- Full IDE, code editor, Git client, or terminal multiplexer
- Worktree creation, autonomous merging, or automatic code application
- Multi-Agent autonomous planning, debate, or indefinite loops
- Token-optimization claims or automatic Session splitting
- Vector database, knowledge base, or long-term memory system
- Team collaboration, accounts, cloud SaaS, or mobile clients
- Desktop installer

## 11. Deferred V1.1 Review Questions

Review will be designed only after V1 usage provides evidence. Open questions include:

1. Is Review requested from a Session, a Task, a Git Diff, or more than one source?
2. What neutral context belongs in the Review Case File?
3. Where should a running Review and its result appear without becoming a top-level product area?
4. Is Review primarily code review, task validation, or general second opinion?
5. Which second Provider and execution boundary should V1.1 use?
6. How are findings accepted, rejected, or linked back to work without changing code automatically?

No schema or UI placeholder should pre-decide these answers in V1.

## 12. Delivery Order — No Dates Yet

Implementation remains paused until explicitly resumed. When resumed, use this order:

### Phase 0 — Codex Session Spike

- verify native enumeration and resume behavior;
- identify stable metadata and version risks;
- prove one real Session can be discovered and continued from Node.js.

### Phase 1 — Page shell with isolated fixtures

- Home;
- Sessions list and detail;
- Tasks list and detail;
- navigation and empty/error states.

Fixture UI is a design checkpoint, not V1 completion.

### Phase 2 — Session vertical slice

- SQLite foundation and migrations;
- Session Indexer;
- Session search and source health;
- new and continued Session Runs;
- process recovery.

### Phase 3 — Task and contribution loop

- Task lifecycle;
- many-to-many TaskSessionLink;
- contribution timeline;
- Home continuation and attention views.

### Phase 4 — Hardening and release evidence

- adversarial state tests;
- browser E2E;
- diagnostics and error experience;
- README, architecture diagram, setup guide, and demo.

A dated implementation schedule will be created only after development is authorized and Phase 0 risk is measured.

## 13. Quality and Safety Gates

- Every implementation change follows Red–Green–Refactor.
- Tests use isolated, redacted fixtures and stores.
- Local experiments never write to native or production user data.
- UI flows are verified in a real browser.
- Native Session provenance is visible to the user.
- Failures expose the affected object and recovery action in context.
- V1 is not complete with mock-only data.

## 14. Interview Narrative for V1

> I built a focused local workbench after accumulating coding-agent Sessions that were difficult to find and continue. TaskMux indexes native Codex history without taking ownership of it, supervises new and resumed Runs, and models Task and Session as independent first-class objects connected through a many-to-many contribution relationship. I deliberately shipped the reliable single-provider workflow first. Cross-model Review is deferred until actual use tells me where it belongs instead of forcing a decorative multi-Agent feature into the interface.

## 15. Decision Record

Confirmed on 2026-08-20:

- Building a smaller, focused Codeg-like workbench is acceptable because the primary goals are self-use and engineering learning, not feature novelty.
- Task and Session are equal first-class objects.
- Task–Session is many-to-many.
- The relationship records contribution and never propagates completion automatically.
- Home, Sessions, and Tasks are the only V1 primary destinations.
- Review is not a first-class destination.
- Review is deferred entirely to V1.1 while its role and placement are reconsidered.
- V1 uses manual Task–Session association.
- Development must not begin until the operator explicitly resumes it.

## 16. Current State and Next Trigger

Current state:

- V1 product scope: confirmed;
- low-fidelity information architecture: direction accepted;
- implementation: not started and intentionally paused;
- repository initialization and technical Spike: not authorized yet.

Next trigger:

> The operator explicitly asks to start implementation or to refine a specific V1 page/interaction.

Until then, this document is the single truth source for TaskMux V1 scope.

## Convergence Check

1. Rejected design → ADR? No separate ADR repository exists yet; Task-first, Session-first, and V1 Review decisions are recorded in this document.
2. New operational lesson → lessons file? No new reusable cross-project lesson was produced.
3. New team rule → guide file? No team-wide operating rule was created.
