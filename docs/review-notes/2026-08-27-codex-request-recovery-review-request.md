---
feature_ids:
  - taskmux-text-v1
topics:
  - codex
  - error-recovery
doc_kind: review-request
created: 2026-08-27
---

# Review Request: Codex Request Recovery

Review-Target-ID: fix-codex-request-recovery
Branch: fix/codex-request-recovery
Base: `origin/feature/taskmux-text-v1` (`0189b38`)
Code HEAD after review round 1 fixes: `e5ef568`

## What

Classify request-level Codex App Server failures, expose only a sanitized stable
503 error, release failed send ownership, and replace a transiently unusable
App Server once without replaying the prompt. The next explicit operator send
uses the replacement. Repeated failure degrades health without a restart loop.

## Why

A rejected `turn/start` previously became a generic `internal_error`; if the
App Server process stayed alive but unusable, later sends kept hitting the same
bad client. The operator could neither diagnose the Codex failure nor recover by
sending again.

## Original Requirements

> “上一轮发送失败后，后续就没办法发送成功了吗？这不合理吧。”
> “把 Codex 的错误透传，方便定位。”

- 来源：`docs/superpowers/specs/2026-08-26-codex-request-recovery-design.md`
- **请对照上面的 operator experience 判断交付物是否解决了问题。**

## Tradeoff

TaskMux does not automatically replay a failed prompt because `turn/start`
acceptance may be uncertain and replay could duplicate a turn. Unknown response
errors are non-recoverable by default; only explicit transport/protocol failures
and the observed child-process timeout consume the one-restart budget.

## Architecture Ownership

Architecture cell: provider runtime / conversation transport
Map delta: none
Why: this extends the existing JSON-RPC event boundary, runtime restart budget,
replaceable adapter, HTTP error mapper, and conversation reducer.

Please verify that the diff matches `Map delta: none`, adds no parallel Store,
Queue, Router, Adapter, Dispatcher, or Binding, and does not change canonical
ownership anchors.

## Open Questions

### Technical OQ

- Can event-before-Promise settlement, stdin error, process exit, and `stop()`
  interleave without stale-client mutation, double budget consumption, or an
  untyped HTTP failure?
- Is the public error boundary fail-safe for env values, paths, stack lines,
  JSON-RPC data, stderr, request params, and raw frames?
- Do business/unknown failures avoid restart while known transport failures
  recover exactly once?
- Is the no-auto-replay guarantee preserved across every failure path?

### Value OQ

None.

## Fresh-Context Findings

Agent: `/root/fresh_scan_request_recovery`
SHA scanned: `bc88786`
Total findings: 2 (0 Critical, 2 Important, 0 Minor)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | `publicMessage` could expose env values, file URIs, UNC paths, and stack lines | fixed in `803c275` with response and constructor-boundary tests | resolved |
| FC-2 | stopped stdin could reject untyped and leave a bad client installed | fixed in `803c275` with a real live-child stdin fixture | resolved |

Formal review round 1 verdict was NOT APPROVED with two Important and one Minor:

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FR-1 | FC-1 sanitizer remained blacklist-based and leaked authorization/cwd/prompt variants | replaced by fail-closed diagnostic allowlist in `e5ef568` | resolved |
| FR-2 | immediate retry could hit unavailable before replacement ready | replaceable adapter holds explicit operations through delayed stop/start in `e5ef568` | resolved |
| FR-3 | automatic recovery could briefly show manual restart action | automatic in-progress health remains ok; degraded action only after failure/exhaustion in `e5ef568` | resolved |

Re-review evidence on `8db693c`: focused 5 files / 177 tests, typecheck, and
Chromium 10/10 all passed independently. Reviewer confirmed no remaining
Critical or Important finding and prepared `APPROVED with Minor`; its final
formatted response was interrupted by reviewer quota after that conclusion was
reported. The retained Minor is the idempotence of two already-safe normalized
messages and is non-blocking.

Formal reviewer: please label findings `[FC:covered]`, `[FC:new]`, or `[FC:N/A]`.

## Next Action

Perform a read-only independent review of the full base-to-HEAD diff. Return
Critical/Important/Minor findings with exact file/line evidence and an APPROVED
verdict only if no Critical or Important issue remains. Re-run focused tests and
the real browser E2E path; do not trust author-reported results alone.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-codex-request-recovery/reviewer`
- Start command: `COREPACK_HOME=/private/tmp/taskmux-corepack COREPACK_ENABLE_PROJECT_SPEC=1 corepack pnpm dev -- --port 4321`
- Ports: `web=4321`, `api=4321`

Bootstrap:

```bash
unset NODE_ENV
COREPACK_HOME=/private/tmp/taskmux-corepack COREPACK_ENABLE_PROJECT_SPEC=1 corepack pnpm install --frozen-lockfile
```

The deterministic Playwright harness is self-contained and uses isolated
ephemeral HTTP/data state, so reviewers may use `pnpm test:e2e` instead of
starting the manual dev server.

## Self-check Evidence

### Spec Compliance

`docs/review-notes/2026-08-27-codex-request-recovery-quality-gate.md` maps the
operator requirement and INV-1 through INV-7 to runtime, HTTP, client, and E2E
evidence. Architecture map delta is none; artifact and fallback scans passed.

### Validation

```text
pnpm typecheck                 PASS
pnpm test                      PASS, 20 files / 322 tests
pnpm build                     PASS, Vite 24 modules + server TypeScript
pnpm test:e2e                  PASS, Chromium 10/10
focused high-risk suites       PASS, 5 files / 176 tests
git diff --check               PASS
```

Browser evidence from the end-to-end recovery path:

- Screenshot: `/private/tmp/taskmux-evidence/codex-request-recovery/request-recovery-success.png`
- Video: `/private/tmp/taskmux-evidence/codex-request-recovery/page@f4efcf0ea2f47878c7c40d95fef7a684.webm`

The browser path covers Composer → HTTP → service → adapter → JSON-RPC rejection
→ process replacement → explicit retry → SSE assistant response. Real Codex was
not called; the fixture reproduces the observed error deterministically.

### Related Documents

- Design: `docs/superpowers/specs/2026-08-26-codex-request-recovery-design.md`
- Plan: `feature-specs/2026-08-26-codex-request-recovery.md`
- Quality gate: `docs/review-notes/2026-08-27-codex-request-recovery-quality-gate.md`
