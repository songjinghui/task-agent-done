import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientEvent,
  type CodexProcessOptions,
} from "./json-rpc-client.js"

const fixturePath = resolve(process.cwd(), "tests/fixtures/fake-app-server.mjs")
const workspaces: string[] = []
const clients: CodexJsonRpcClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()))
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true })
  }
})

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "taskmux-codex-client-"))
  workspaces.push(workspace)
  return workspace
}

function fakeProcessOptions(cwd: string): CodexProcessOptions {
  return {
    command: process.execPath,
    args: [fixturePath],
    cwd,
  }
}

async function startClient(): Promise<{ client: CodexJsonRpcClient; workspace: string }> {
  const workspace = createWorkspace()
  const client = new CodexJsonRpcClient(fakeProcessOptions(workspace))
  clients.push(client)
  await client.start({ name: "taskmux", title: "TaskMux", version: "0.1.0" })
  return { client, workspace }
}

function nextEvent(
  client: CodexJsonRpcClient,
  predicate: (event: CodexJsonRpcClientEvent) => boolean
): Promise<CodexJsonRpcClientEvent> {
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe((event) => {
      if (predicate(event)) {
        unsubscribe()
        resolve(event)
      }
    })
  })
}

describe("CodexJsonRpcClient", () => {
  it("accepts a split handshake response and correlates thread/start responses", async () => {
    const workspace = createWorkspace()
    const client = new CodexJsonRpcClient(fakeProcessOptions(workspace))
    clients.push(client)

    await client.start({ name: "taskmux", title: "TaskMux", version: "0.1.0" })
    const first = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })
    const second = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })

    expect(first.thread.id).toBe("thr_1")
    expect(second.thread.id).toBe("thr_2")
  })

  it("does not send application requests before initialized is sent", async () => {
    const workspace = createWorkspace()
    const client = new CodexJsonRpcClient(fakeProcessOptions(workspace))
    clients.push(client)
    const starting = client.start({ name: "taskmux", title: "TaskMux", version: "0.1.0" })

    await expect(client.request("thread/start", { cwd: workspace })).rejects.toThrow(
      "app_server_not_started"
    )
    await starting
  })

  it("applies an explicit timeout to the initialize handshake", async () => {
    const workspace = createWorkspace()
    const client = new CodexJsonRpcClient({
      command: process.execPath,
      args: [fixturePath, "--ignore-initialize"],
      cwd: workspace,
    })
    clients.push(client)

    await expect(
      client.start(
        { name: "taskmux", title: "TaskMux", version: "0.1.0" },
        25
      )
    ).rejects.toThrow("app_server_request_timeout")
  })

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

  it("delivers item notifications from an in-memory hello turn", async () => {
    const { client, workspace } = await startClient()
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })
    const firstDelta = nextEvent(
      client,
      (event) =>
        event.type === "notification" &&
        event.method === "item/agentMessage/delta" &&
        (event.params as { delta?: string }).delta === "hello "
    )
    const secondDelta = nextEvent(
      client,
      (event) =>
        event.type === "notification" &&
        event.method === "item/agentMessage/delta" &&
        (event.params as { delta?: string }).delta === "world"
    )
    const completed = nextEvent(
      client,
      (event) => event.type === "notification" && event.method === "turn/completed"
    )

    await client.request("turn/start", { threadId: thread.thread.id, prompt: "hello" })

    await expect(firstDelta).resolves.toMatchObject({ type: "notification" })
    await expect(secondDelta).resolves.toMatchObject({ type: "notification" })
    await expect(completed).resolves.toMatchObject({ type: "notification" })
  })

  it("reports malformed output while continuing to correlate later responses", async () => {
    const { client } = await startClient()
    const protocolError = nextEvent(
      client,
      (event) => event.type === "protocol_error" && event.message === "invalid_json"
    )

    await expect(client.request("test/malformed")).resolves.toEqual({ ok: true })
    await expect(protocolError).resolves.toMatchObject({
      type: "protocol_error",
      raw: "{not valid JSON}",
    })
  })

  it("rejects explicit non-current JSON-RPC versions without notifying subscribers", async () => {
    const { client } = await startClient()
    const events: CodexJsonRpcClientEvent[] = []
    client.subscribe((event) => events.push(event))

    await expect(client.request("test/invalid-version")).resolves.toEqual({ ok: true })

    expect(events).toContainEqual({
      type: "protocol_error",
      message: "invalid_json_rpc_message",
      raw: '{"jsonrpc":"1.0","method":"test/invalid-version"}',
    })
    expect(events).not.toContainEqual({
      type: "notification",
      method: "test/invalid-version",
    })
  })

  it("captures app-server stderr without treating it as JSON-RPC", async () => {
    const { client } = await startClient()

    await client.request("test/stderr")
    await expect.poll(() => client.stderr).toContain("fake app-server diagnostic")
  })

  it("rejects a request that exceeds its timeout", async () => {
    const { client } = await startClient()
    const events: CodexJsonRpcClientEvent[] = []
    client.subscribe((event) => events.push(event))

    await expect(client.request("test/timeout", undefined, 25)).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "app_server_request_timeout",
      method: "test/timeout",
      recoverable: true,
    })
    expect(events).toContainEqual({
      type: "request_failure",
      method: "test/timeout",
      code: "app_server_request_timeout",
      message: "Codex App Server request timed out.",
      recoverable: true,
    })
  })

  it("classifies a Codex internal child-process timeout without exposing error data", async () => {
    const { client } = await startClient()
    const events: CodexJsonRpcClientEvent[] = []
    client.subscribe((event) => events.push(event))

    await expect(
      client.request("test/recoverable-error", { prompt: "private prompt" })
    ).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "codex_request_failed",
      method: "test/recoverable-error",
      message: "timeout waiting for child process to exit",
      recoverable: true,
    })
    expect(events).toContainEqual({
      type: "request_failure",
      method: "test/recoverable-error",
      code: "codex_request_failed",
      message: "timeout waiting for child process to exit",
      recoverable: true,
    })
    expect(JSON.stringify(events)).not.toContain("private prompt")
    expect(JSON.stringify(events)).not.toContain("private/secret")
    expect(JSON.stringify(events)).not.toContain("rawRequest")
  })

  it("keeps business request failures non-recoverable while preserving a safe message", async () => {
    const { client } = await startClient()
    const events: CodexJsonRpcClientEvent[] = []
    client.subscribe((event) => events.push(event))

    await expect(client.request("test/business-error")).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "codex_request_failed",
      method: "test/business-error",
      message: "thread_not_found",
      recoverable: false,
    })
    expect(events).toContainEqual({
      type: "request_failure",
      method: "test/business-error",
      code: "codex_request_failed",
      message: "thread_not_found",
      recoverable: false,
    })
    expect(JSON.stringify(events)).not.toContain("private-thread-id")
  })

  it("delivers command approvals and sends an explicit response", async () => {
    const { client, workspace } = await startClient()
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })
    const approval = nextEvent(
      client,
      (event) =>
        event.type === "server_request" &&
        event.method === "item/commandExecution/requestApproval"
    )
    const completed = nextEvent(
      client,
      (event) => event.type === "notification" && event.method === "turn/completed"
    )

    await client.request("turn/start", { threadId: thread.thread.id, prompt: "[approval]" })
    const event = await approval
    if (event.type !== "server_request") throw new Error("expected server request")
    client.respond(event.id, { decision: "accept" })

    await expect(completed).resolves.toMatchObject({ type: "notification" })
  })

  it("delivers file approvals as server requests", async () => {
    const { client, workspace } = await startClient()
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })
    const approval = nextEvent(
      client,
      (event) =>
        event.type === "server_request" &&
        event.method === "item/fileChange/requestApproval"
    )

    await client.request("turn/start", { threadId: thread.thread.id, prompt: "[file]" })

    await expect(approval).resolves.toMatchObject({ type: "server_request" })
  })

  it("rejects unresolved requests when the app server exits unexpectedly", async () => {
    const { client, workspace } = await startClient()
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
    })
    const exit = nextEvent(client, (event) => event.type === "exit")
    const request = client.request("turn/start", {
      threadId: thread.thread.id,
      prompt: "[crash]",
    })

    await expect(request).rejects.toThrow("app_server_exited")
    await expect(exit).resolves.toMatchObject({ type: "exit", code: 17 })
  })

  it("includes trailing stderr in the exit event", async () => {
    const { client } = await startClient()
    const exit = nextEvent(client, (event) => event.type === "exit")
    const request = client.request("turn/start", { prompt: "[crash-stderr]" })

    await expect(request).rejects.toThrow("app_server_exited")
    await expect(exit).resolves.toMatchObject({
      type: "exit",
      code: 17,
      stderr: expect.stringContaining("fake app-server trailing diagnostic"),
    })
  })

  it("stops idempotently and rejects unresolved requests", async () => {
    const { client } = await startClient()
    const request = client.request("test/timeout")
    const rejectedRequest = expect(request).rejects.toThrow("app_server_stopped")

    await client.stop()
    await client.stop()

    await rejectedRequest
  })

  it("escalates from TERM to KILL and resolves when the child ignores TERM", async () => {
    const { client } = await startClient()
    await client.request("test/ignore-term")
    const exit = nextEvent(client, (event) => event.type === "exit")

    await client.stop(25)

    await expect(exit).resolves.toMatchObject({ type: "exit", signal: "SIGKILL" })
  })
})
