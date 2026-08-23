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

  it("captures app-server stderr without treating it as JSON-RPC", async () => {
    const { client } = await startClient()

    await client.request("test/stderr")
    await expect.poll(() => client.stderr).toContain("fake app-server diagnostic")
  })

  it("rejects a request that exceeds its timeout", async () => {
    const { client } = await startClient()

    await expect(client.request("test/timeout", undefined, 25)).rejects.toThrow(
      "app_server_request_timeout"
    )
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
})
