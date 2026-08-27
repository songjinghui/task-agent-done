---
topics: [sop, workflow]
doc_kind: note
created: 2026-08-24
---

# Standard Operating Procedure

## Workflow (6 steps)

| Step | What | Skill |
|------|------|-------|
| 1 | Freeze the approved design and implementation plan | `brainstorming` / `writing-plans` |
| 2 | Create an isolated worktree and verify the baseline | `worktree` |
| 3 | Implement with Red–Green–Refactor | `tdd` |
| 4 | Check vision, spec compliance, tests, and real-provider behavior | `quality-gate` |
| 5 | Request and receive independent review | `request-review` / `receive-review` |
| 6 | Merge, record the delivered truth, and clean up | `merge-gate` |

## Code Quality

- Types: `env -u NODE_ENV pnpm typecheck`
- Unit and component tests: `NODE_ENV=test pnpm test`
- Browser acceptance: `NODE_ENV=test pnpm test:e2e`
- Production build: `env -u NODE_ENV pnpm build`
- Real Codex checks must use an explicitly disposable workspace and must never read or write production user data.
