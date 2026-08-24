# Codex App Server 0.147 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start TaskMux successfully against `codex-cli 0.147.0` and keep the browser available when a future initialize handshake is unsupported.

**Architecture:** Keep `CodexJsonRpcClient` as the only raw App Server wire boundary. Emit the current Codex newline-delimited envelope without a `jsonrpc` member, parse both current envelopes and former explicit `"2.0"` envelopes, and map only recognized handshake compatibility failures to existing degraded health.

**Tech Stack:** TypeScript, Node.js child processes, Vitest, Fastify, Vite, Playwright, Codex App Server JSONL.

## Global Constraints

- Real compatibility target is the locally installed `codex-cli 0.147.0`.
- Outbound App Server messages omit `jsonrpc`.
- Inbound messages accept absent `jsonrpc` or exactly `"2.0"`; other explicit values remain protocol errors.
- No timeout-based resend or duplicate initialize request.
- Raw Codex protocol data remains server-private.
- Real validation uses a disposable workspace and does not send a model turn or approve tools.

---

### Task 1: Current Codex JSONL Envelope

**Files:**
- Modify: `tests/fixtures/fake-app-server.mjs`
- Modify: `src/server/codex/json-rpc-client.test.ts`
- Modify: `src/server/codex/json-rpc-client.ts`

**Interfaces:**
- Consumes: `CodexJsonRpcClient.start`, `request`, `respond`, and line-oriented child stdio.
- Produces: outbound `{ id, method, params? }` / `{ method, params? }` / `{ id, result }` messages and tolerant inbound envelope validation.

- [ ] **Step 1: Add a current-envelope fake mode and failing regression test**

Add a `--current-jsonl` fixture mode. In that mode, ignore an initialize request if it contains a `jsonrpc` property and omit `jsonrpc` from fake responses and notifications. Add this test:

```ts
it("uses the current Codex JSONL envelope without a jsonrpc member", async () => {
  const workspace = createWorkspace()
  const client = new CodexJsonRpcClient({
    command: process.execPath,
    args: [fixturePath, "--current-jsonl"],
    cwd: workspace,
  })
  clients.push(client)

  await client.start(
    { name: "taskmux", title: "TaskMux", version: "0.1.0" },
    100
  )
  await expect(client.request("test/current-envelope")).resolves.toEqual({ ok: true })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/server/codex/json-rpc-client.test.ts
```

Expected: FAIL with `app_server_request_timeout` because TaskMux still sends `jsonrpc: "2.0"`.

- [ ] **Step 3: Emit the Codex 0.147 envelope and accept both inbound variants**

Change `#write` to serialize the supplied message without injecting `jsonrpc`. Replace the strict check in `#handleLine` with:

```ts
if (
  !isRecord(message) ||
  (Object.hasOwn(message, "jsonrpc") && message.jsonrpc !== "2.0")
) {
  this.#emit({ type: "protocol_error", message: "invalid_json_rpc_message", raw: line })
  return
}
```

Remove every `jsonrpc: "2.0"` literal from client-produced request, notification, and response objects. Keep the fake fixture's default former-format output so the existing suite continues to prove inbound compatibility.

- [ ] **Step 4: Add invalid-version coverage**

Add a fixture request that emits `{ jsonrpc: "1.0", method: "test/invalid-version" }`. Assert that the client emits `protocol_error` with `invalid_json_rpc_message` and does not expose the raw event as a notification.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/server/codex/json-rpc-client.test.ts
```

Expected: all client tests pass, including current envelope, former inbound envelope, and invalid explicit version.

- [ ] **Step 6: Commit the protocol change**

```bash
git add tests/fixtures/fake-app-server.mjs \
  src/server/codex/json-rpc-client.test.ts \
  src/server/codex/json-rpc-client.ts
git commit -m "fix: support current Codex App Server envelopes"
```

---

### Task 2: Resilient Handshake Diagnostics

**Files:**
- Modify: `src/server/main.test.ts`
- Modify: `src/server/main.ts`

**Interfaces:**
- Consumes: errors raised by `RuntimeCodexClient.start`.
- Produces: existing `AppHealth` error code `codex_version_unsupported` while the loopback HTTP service remains available.

- [ ] **Step 1: Add failing degraded-start tests**

Add a parameterized test for `app_server_request_timeout` and `invalid_initialize_response`:

```ts
it.each(["app_server_request_timeout", "invalid_initialize_response"])(
  "keeps HTTP available for unsupported initialize failure %s",
  async (message) => {
    const harness = makeRuntimeHarness({ startErrors: [new Error(message)] })
    const running = await startTaskMux(makeConfig(), harness.dependencies)

    expect(running.health()).toEqual({
      status: "degraded",
      error: {
        code: "codex_version_unsupported",
        message: "This Codex CLI version does not support app-server.",
      },
    })
    const response = await running.app.inject({ method: "GET", url: "/api/health" })
    expect(response.statusCode).toBe(503)
    await running.shutdown()
  }
)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/server/main.test.ts
```

Expected: FAIL because `startTaskMux` currently rethrows both errors and never listens.

- [ ] **Step 3: Classify only known compatibility failures**

Extend `handshakeDiagnostic` so `app_server_request_timeout` and `invalid_initialize_response` return the existing sanitized `codex_version_unsupported` diagnostic. Preserve the authentication branch and continue returning `null` for unclassified transport/construction errors.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/server/main.test.ts src/server/codex/json-rpc-client.test.ts
```

Expected: all focused tests pass and the existing unclassified-failure rollback test remains green.

- [ ] **Step 5: Commit startup resilience**

```bash
git add src/server/main.test.ts src/server/main.ts
git commit -m "fix: keep TaskMux available on handshake mismatch"
```

---

### Task 3: Release and Real Codex Verification

**Files:**
- Modify only if verification exposes a documented mismatch.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a verified TaskMux process listening on `127.0.0.1:4317` with Codex 0.147.0 initialized.

- [ ] **Step 1: Run the complete automated gate**

Run sequentially:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Launch against the real current Codex CLI**

Run:

```bash
mkdir -p /private/tmp/taskmux-playground /private/tmp/taskmux-data
TASKMUX_DATA_DIR=/private/tmp/taskmux-data \
  pnpm dev -- --workspace /private/tmp/taskmux-playground --port 4317
```

Do not send a turn. Verify from a second shell:

```bash
curl --fail http://127.0.0.1:4317/api/health
curl --fail --output /dev/null http://127.0.0.1:4317/
```

Expected: both commands succeed; health is `{ "status": "ok" }`.

- [ ] **Step 3: Stop the real process and verify hygiene**

Send `Ctrl+C`, then verify:

```bash
git status --short
find /private/tmp -maxdepth 1 -name 'taskmux-e2e-*' -print
ps -Ao pid,command | rg 'fake-app-server|tsx watch src/server/main' || true
```

Expected: no uncommitted generated artifacts, E2E temp directories, or TaskMux child processes.

- [ ] **Step 4: Push the verified branch**

```bash
git push origin feature/taskmux-text-v1
git ls-remote --heads origin feature/taskmux-text-v1
```

Expected: the remote branch SHA equals local `HEAD`.
