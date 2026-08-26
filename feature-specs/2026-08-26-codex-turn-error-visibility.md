---
feature_ids:
  - taskmux-codex-error-visibility
topics:
  - codex
  - errors
  - workbench
doc_kind: implementation-plan
created: 2026-08-26
---

# Codex Turn Error Visibility Implementation Plan

**Feature:** `docs/superpowers/specs/2026-08-26-codex-turn-error-visibility-design.md`
**Goal:** A prompt that ends without assistant text produces a useful Codex error or a clear failed/interrupted notice instead of a silent thread.
**Acceptance Criteria:** Forward only non-blank Codex `codexErrorInfo` and `message` on failed turns; retain the sanitized fallback for missing/malformed data and unsupported statuses; render live error text ahead of fixed failed/interrupted notices; never auto-retry or expose other raw fields.
**Architecture cell:** N/A — existing Codex adapter → shared terminal error event → existing client live state and Thread projection.
**Map delta:** none
**Map delta why:** This changes normalization and rendering inside existing ownership boundaries; it adds no component or lifecycle owner.
**Architecture:** Extract the two approved fields at the Codex adapter boundary and reuse the existing terminal error envelope. Derive the fallback notice directly from `ConversationSummary.status` and `liveError`; do not store a second terminal-state flag.
**Tech Stack:** TypeScript, React, Vitest, Testing Library, Playwright.
**前端验证:** Yes — focused component tests plus the existing browser E2E gate.

---

## Finish line and terminal schema

The final browser event remains the existing terminal turn error:

```ts
{
  type: "error"
  code: codexErrorInfo ?? "turn_failed"
  message: codexMessage ?? "Agent turn failed."
  terminal: true
  scope: "turn"
  turnId: string
}
```

The client adds no state field. Its displayed alert is a pure projection:

```ts
liveError ??
  (conversation.status === "failed" ? FAILED_NOTICE :
   conversation.status === "interrupted" ? INTERRUPTED_NOTICE : null)
```

We are not adding durable error storage, a database migration, automatic retry,
or any ACP behavior.

## Lifecycle census

No new stateful object is introduced. Existing `ConversationSummary.status` is
owned by `ConversationService`/repository, and existing `live.error` is owned by
the client reducer. `Thread` only projects those values, so there is no new
state transition table, recovery path, or concurrency owner to synchronize.

Invariants:

- INV-1: Only failed Codex turns may forward selected provider error fields.
- INV-2: No raw field other than `codexErrorInfo` and `message` reaches the event.
- INV-3: Live error text wins over a fixed status notice.
- INV-4: Running, idle, or completed state cannot retain a fixed terminal notice.
- INV-5: Rendering never triggers a retry or provider call.

### Task 1: Forward selected failed-turn error fields

**Files:**
- Modify: `src/server/codex/codex-adapter.ts:52-56,338-363`
- Test: `src/server/codex/codex-adapter.test.ts:673-721`

**Step 1: Write the failing adapter tests**

Replace the old blanket-sanitization expectation with cases that assert:

```ts
turn: {
  id: "turn_failed",
  status: "failed",
  error: {
    codexErrorInfo: "usageLimitExceeded",
    message: "You've hit your usage limit. Try again later.",
    additionalDetails: "must not escape",
  },
}
```

emits exactly `code: "usageLimitExceeded"` and the provided `message`, while
missing, blank, or non-string selected fields emit `turn_failed` / `Agent turn
failed.`. Keep the unsupported-status case sanitized and assert serialized
events do not contain `additionalDetails` or another private fixture field.

**Step 2: Run the focused RED test**

Run:

```bash
pnpm vitest run src/server/codex/codex-adapter.test.ts -t "failed terminal turn"
```

Expected: FAIL because the adapter still emits `turn_failed` and `Agent turn failed.`.

**Step 3: Implement the minimal adapter normalization**

Add an optional `error` field to the local `CodexTurn` shape and a small helper
that uses existing record/string guards:

```ts
function failedTurnError(turn: Record<string, unknown>) {
  const error = recordField(turn, "error")
  const code = error && nonBlankStringField(error, "codexErrorInfo")
  const message = error && nonBlankStringField(error, "message")
  return {
    code: code ?? "turn_failed",
    message: message ?? "Agent turn failed.",
  }
}
```

Use it only when `status === "failed"`; leave unsupported status handling
unchanged. Reuse an existing non-blank string guard or add a local helper if the
current `stringField` intentionally accepts blank text.

**Step 4: Run focused GREEN and adapter regression tests**

Run:

```bash
pnpm vitest run src/server/codex/codex-adapter.test.ts
```

Expected: all adapter tests pass; INV-1 and INV-2 are covered.

**Step 5: Commit Task 1**

```bash
git add src/server/codex/codex-adapter.ts src/server/codex/codex-adapter.test.ts
git commit -m "fix: surface Codex turn errors"
```

### Task 2: Render terminal fallback notices

**Files:**
- Modify: `src/client/components/Thread.tsx:71-122`
- Test: `src/client/App.test.tsx`

**Step 1: Write failing client tests**

Add tests with a selected summary and history proving:

- `status: "failed"` with no `liveError` renders `上一轮执行失败。`.
- `status: "interrupted"` with no `liveError` renders `上一轮已中断。`.
- A live terminal error renders its provider message and hides the fixed failed notice.
- A subsequent running/completed state hides the fixed terminal notice.

**Step 2: Run the focused RED tests**

Run:

```bash
pnpm vitest run src/client/App.test.tsx -t "terminal notice|provider error"
```

Expected: FAIL because `Thread` currently renders only `liveError`.

**Step 3: Implement the pure projection**

In `Thread`, compute:

```ts
const terminalError =
  liveError ??
  (conversation.status === "failed"
    ? "上一轮执行失败。"
    : conversation.status === "interrupted"
      ? "上一轮已中断。"
      : null)
```

Render `terminalError` in the existing `.turn-error` alert. Do not add reducer
state or effects.

**Step 4: Run focused client GREEN tests**

Run:

```bash
pnpm vitest run src/client/App.test.tsx
```

Expected: all App tests pass; INV-3 through INV-5 are covered.

**Step 5: Commit Task 2**

```bash
git add src/client/components/Thread.tsx src/client/App.test.tsx
git commit -m "fix: explain terminal turns without replies"
```

### Task 3: Quality gate, review, and delivery

**Files:**
- Verify only; update bug report if required by the debugging workflow.

**Step 1: Run focused verification**

```bash
pnpm vitest run src/server/codex/codex-adapter.test.ts src/client/App.test.tsx
```

Expected: all focused tests pass.

**Step 2: Run the complete gate sequentially**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
git diff --check
```

Expected: every command exits 0. The running local 4317 instance may continue
to own Vite's development WebSocket port; disclose environmental warnings rather
than treating a green E2E exit as silent evidence.

**Step 3: Verify the real failure projection without a model turn**

Use a fake App Server or focused adapter test fixture to send a real-shaped
failed `turn/completed` notification. Do not spend credits or trigger tools.

**Step 4: Cross-family review**

Provide the approved design, this plan, the implementation diff, RED/GREEN
evidence, and full gate results to a read-only reviewer. Fix all Critical or
Important findings and request re-review.

**Step 5: Push the named feature branch**

```bash
git push -u origin feature/taskmux-text-v1
git ls-remote --heads origin feature/taskmux-text-v1
```

Expected: the remote branch SHA equals local `HEAD`. Do not stage the unrelated
ACP draft, `.DS_Store`, or root documentation files.
