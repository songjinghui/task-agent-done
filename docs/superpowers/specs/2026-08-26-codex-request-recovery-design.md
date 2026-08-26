---
feature_ids:
  - taskmux-text-v1
topics:
  - codex
  - error-recovery
  - app-server
doc_kind: design
created: 2026-08-26
---

# Codex Request Recovery Design

## Goal

When Codex App Server rejects or times out a `turn/start` request before creating a turn, TaskMux must release the current send, report a useful sanitized error, recover the provider process when the failure is transient, and allow the operator to send again.

## Scope

This change covers request-level failures that happen before Codex accepts a turn. It does not automatically resubmit prompts, change terminal turn handling, persist provider errors in SQLite, or restart Codex for business failures such as usage limits, authentication requirements, invalid input, or missing threads.

## Failure Classification

The JSON-RPC client retains a stable TaskMux error code, the upstream message, the method, and whether the failure is recoverable. It never forwards the JSON-RPC `data` object, stack traces, stderr, environment variables, paths, request payloads, or raw protocol frames.

Recoverable request failures are transport/protocol failures and Codex internal request failures that indicate a temporarily unusable App Server, including request timeout, stopped/exited process, invalid protocol response, and the observed model-refresh child-process timeout. Business and operator-action errors remain non-recoverable.

Unknown errors are not automatically treated as recoverable. They remain safe server errors so a new upstream message cannot silently create a restart loop.

## Runtime Recovery

The runtime supervisor observes typed recoverable failures for `turn/start`. The failed HTTP request is not retried: this prevents duplicate turns when acceptance is uncertain. Conversation ownership is released by the existing service failure path.

After the failed request settles, the supervisor replaces the Codex client and adapter once using the existing restart budget and stale-client isolation. A successful replacement returns health to `ok`, so the next explicit operator send uses the new App Server. If replacement fails, or another recoverable failure occurs before a later owned turn completes, health becomes `degraded` and the existing stable restart action remains available.

Events and async completions from the retired client cannot mutate the replacement adapter, conversation status, or restart budget.

## HTTP and UI Errors

Known provider request errors no longer fall through to `internal_error`:

- HTTP status: `503`
- stable code: `codex_request_failed` for typed Codex request rejection, or the existing stable transport code when one already exists
- message: the sanitized upstream Codex message when present; otherwise a fixed provider-unavailable message

The Composer displays that safe API message for a rejected send. Genuine unclassified TaskMux defects continue to return the fixed `internal_error` response.

## State Invariants

- INV-1: A rejected `turn/start` never retains global or per-conversation active ownership.
- INV-2: TaskMux never automatically submits the same prompt twice.
- INV-3: At most one replacement attempt consumes the current restart budget.
- INV-4: Business failures do not consume restart budget.
- INV-5: A retired client cannot publish current events or change health.
- INV-6: Provider error exposure is limited to stable code plus sanitized message.
- INV-7: After successful replacement, the next explicit send can start normally.

## Test Strategy

Tests will first reproduce the current behavior: a Codex request rejection becomes HTTP 500, the provider remains installed, and a subsequent send fails against the same client.

Coverage will then verify:

1. JSON-RPC response errors preserve only safe typed fields and classify the observed child-process timeout as recoverable.
2. `turn/start` failure releases service ownership and returns a sanitized 503 response.
3. The runtime replaces the client once, ignores stale-client events, and accepts the next explicit send.
4. Usage-limit/auth/invalid-input failures do not restart the provider.
5. A repeated recoverable failure degrades health without a restart loop.
6. The client renders the safe API message instead of the generic send failure.
7. Full unit, typecheck, build, and browser E2E gates remain green.
