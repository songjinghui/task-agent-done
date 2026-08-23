import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import type {
  ApprovalDecision,
  ConversationEvent,
  MessageTurn,
} from "../shared/contracts.js"
import type { AgentAdapter, AgentAdapterEvent } from "./agent/agent-adapter.js"
import { buildApp, type AppHealth } from "./app.js"
import type { ServerConfig } from "./config.js"
import { ConversationRepository } from "./conversation-repository.js"
import { openDatabase } from "./database.js"
import { EventHub } from "./event-hub.js"

class FakeAgentAdapter implements AgentAdapter {
  readonly createSessionCalls: string[] = []
  readonly readSessionCalls: string[] = []
  readonly resumeSessionCalls: string[] = []
  readonly sendTextCalls: Array<{
    externalSessionId: string
    text: string
    operationId: string
  }> = []
  readonly cancelTurnCalls: string[] = []
  readonly approvalCalls: Array<{
    requestId: string
    decision: ApprovalDecision
  }> = []
  readonly histories = new Map<string, MessageTurn[]>()
  createSessionError: Error | undefined

  #nextSessionId = 1
  #nextTurnId = 1
  readonly #listeners = new Set<(event: AgentAdapterEvent) => void>()
  readonly #operationIds = new Map<string, string>()

  async createSession(workspace: string): Promise<{ externalSessionId: string }> {
    this.createSessionCalls.push(workspace)
    if (this.createSessionError) throw this.createSessionError
    return { externalSessionId: `session-${this.#nextSessionId++}` }
  }

  async readSession(externalSessionId: string): Promise<MessageTurn[]> {
    this.readSessionCalls.push(externalSessionId)
    return this.histories.get(externalSessionId) ?? []
  }

  async resumeSession(externalSessionId: string): Promise<void> {
    this.resumeSessionCalls.push(externalSessionId)
  }

  async sendText(
    externalSessionId: string,
    text: string,
    operationId: string
  ): Promise<{ turnId: string }> {
    this.sendTextCalls.push({ externalSessionId, text, operationId })
    this.#operationIds.set(externalSessionId, operationId)
    return { turnId: `turn-${this.#nextTurnId++}` }
  }

  async cancelTurn(externalSessionId: string): Promise<void> {
    this.cancelTurnCalls.push(externalSessionId)
  }

  async respondToApproval(
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    this.approvalCalls.push({ requestId, decision })
  }

  subscribe(handler: (event: AgentAdapterEvent) => void): () => void {
    this.#listeners.add(handler)
    return () => this.#listeners.delete(handler)
  }

  emit(externalSessionId: string, payload: ConversationEvent): void {
    const operationId = turnBoundPayload(payload)
      ? this.#operationIds.get(externalSessionId)
      : undefined
    for (const listener of this.#listeners) {
      listener({ externalSessionId, operationId, payload })
    }
  }
}

type Harness = {
  adapter: FakeAgentAdapter
  app: FastifyInstance
  config: ServerConfig
  eventHub: EventHub
  repository: ConversationRepository
  controllers: Set<AbortController>
  closeApp(): Promise<void>
  close(): Promise<void>
}
const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close()
  }
})

async function createHarness(options: {
  health?: () => AppHealth
} = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-http-"))
  const database = openDatabase(join(directory, "taskmux.sqlite"))
  const repository = new ConversationRepository(database)
  const adapter = new FakeAgentAdapter()
  const eventHub = new EventHub()
  const config: ServerConfig = {
    workspace: "/fixed/workspace",
    host: "127.0.0.1",
    port: 4317,
    dataDir: directory,
    dev: false,
  }
  const app = await buildApp({
    config,
    repository,
    adapter,
    eventHub,
    health: options.health,
  })
  const controllers = new Set<AbortController>()
  let closed = false
  let appClosed = false
  const harness = {
    adapter,
    app,
    config,
    eventHub,
    repository,
    controllers,
    async closeApp() {
      if (appClosed) return
      appClosed = true
      await app.close()
    },
    async close() {
      if (closed) return
      closed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
      await this.closeApp()
      database.close()
      rmSync(directory, { force: true, recursive: true })
    },
  }
  harnesses.push(harness)
  return harness
}

async function createConversation(harness: Harness) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/conversations",
  })
  expect(response.statusCode).toBe(201)
  return response.json<{
    id: string
    title: string
    status: string
    createdAt: string
    updatedAt: string
  }>()
}

async function listen(harness: Harness): Promise<string> {
  const address = await harness.app.listen({ host: "127.0.0.1", port: 0 })
  return address
}

async function openEventStream(harness: Harness, address: string) {
  const controller = new AbortController()
  harness.controllers.add(controller)
  const response = await fetch(`${address}/api/events`, {
    signal: controller.signal,
  })
  if (!response.body) throw new Error("SSE response did not include a body")
  return {
    controller,
    response,
    reader: response.body.getReader(),
  }
}

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n\n")) {
    const next = await reader.read()
    if (next.done) throw new Error("SSE stream ended before an event arrived")
    text += decoder.decode(next.value, { stream: true })
  }
  return text.slice(0, text.indexOf("\n\n") + 2)
}

function disconnectEventStream(
  stream: Awaited<ReturnType<typeof openEventStream>>
): void {
  stream.controller.abort()
  void stream.reader.cancel().catch(() => {})
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function turnBoundPayload(payload: ConversationEvent): boolean {
  return (
    payload.type === "turn_started" ||
    payload.type === "text_delta" ||
    payload.type === "tool_status" ||
    payload.type === "approval_requested" ||
    payload.type === "turn_completed" ||
    payload.type === "turn_interrupted" ||
    (payload.type === "error" && payload.terminal && payload.scope === "turn")
  )
}

describe("HTTP routes", () => {
  it("reports healthy and degraded runtime state with stable envelopes", async () => {
    const healthy = await createHarness()
    const healthyResponse = await healthy.app.inject({
      method: "GET",
      url: "/api/health",
    })
    expect(healthyResponse.statusCode).toBe(200)
    expect(healthyResponse.json()).toEqual({ status: "ok" })

    const degraded = await createHarness({
      health: () => ({
        status: "degraded",
        error: {
          code: "app_server_exited",
          message: "Agent server is unavailable.",
        },
      }),
    })
    const degradedResponse = await degraded.app.inject({
      method: "GET",
      url: "/api/health",
    })
    expect(degradedResponse.statusCode).toBe(503)
    expect(degradedResponse.json()).toEqual({
      status: "degraded",
      error: {
        code: "app_server_exited",
        message: "Agent server is unavailable.",
      },
    })
  })

  it("returns only the startup-configured workspace", async () => {
    const harness = await createHarness()

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/workspace?workspace=/attacker/path",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ workspace: "/fixed/workspace" })
  })

  it("creates and lists TaskMux conversations without exposing provider IDs", async () => {
    const harness = await createHarness()

    const created = await createConversation(harness)
    const listResponse = await harness.app.inject({
      method: "GET",
      url: "/api/conversations",
    })

    expect(harness.adapter.createSessionCalls).toEqual(["/fixed/workspace"])
    expect(created).toMatchObject({ title: "新会话", status: "idle" })
    expect(created).not.toHaveProperty("externalSessionId")
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json()).toEqual([created])
  })

  it("rejects bodies on create and cancel routes that do not accept input", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const create = await harness.app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { workspace: "/attacker/path" },
    })
    const cancel = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/cancel`,
      payload: { externalSessionId: "thread-secret" },
    })

    expect(create.statusCode).toBe(400)
    expect(create.json().error.code).toBe("invalid_request_body")
    expect(cancel.statusCode).toBe(400)
    expect(cancel.json().error.code).toBe("invalid_request_body")
    expect(harness.adapter.createSessionCalls).toEqual(["/fixed/workspace"])
    expect(harness.adapter.cancelTurnCalls).toEqual([])
  })

  it("loads conversation history through its stored provider mapping", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)
    harness.adapter.histories.set("session-1", [
      { id: "u1", role: "user", text: "hello", status: "completed" },
      { id: "a1", role: "assistant", text: "hi", status: "completed" },
    ])

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      conversationId: conversation.id,
      turns: [
        { id: "u1", role: "user", text: "hello", status: "completed" },
        { id: "a1", role: "assistant", text: "hi", status: "completed" },
      ],
    })
    expect(harness.adapter.readSessionCalls).toEqual(["session-1"])
  })

  it("sends text, rejects a second global turn, and does not accept a browser cwd", async () => {
    const harness = await createHarness()
    const first = await createConversation(harness)
    const second = await createConversation(harness)

    const accepted = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${first.id}/messages`,
      payload: { text: "one", clientRequestId: "send-safe-1" },
    })
    const conflict = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${second.id}/messages`,
      payload: { text: "two", cwd: "/attacker/path" },
    })

    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toEqual({ accepted: true })
    expect(conflict.statusCode).toBe(400)
    expect(conflict.json()).toEqual({
      error: {
        code: "invalid_request_body",
        message: "Request body must contain text and an optional client request ID.",
      },
    })

    const actualConflict = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${second.id}/messages`,
      payload: { text: "two" },
    })
    expect(actualConflict.statusCode).toBe(409)
    expect(actualConflict.json().error.code).toBe("turn_conflict")
    expect(harness.adapter.sendTextCalls.map(({ text }) => text)).toEqual(["one"])
  })

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["non-string", { text: 42 }],
    ["blank", { text: " \n " }],
    ["extra fields", { text: "hello", externalSessionId: "thread-secret" }],
    ["non-string client request ID", { text: "hello", clientRequestId: 42 }],
    ["blank client request ID", { text: "hello", clientRequestId: " \n " }],
    [
      "long client request ID",
      { text: "hello", clientRequestId: "😀".repeat(129) },
    ],
  ])("rejects an invalid messages body: %s", async (_label, payload) => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { "content-type": "application/json" },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
          }),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toMatch(/invalid_(request_body|prompt)/)
    expect(harness.adapter.sendTextCalls).toEqual([])
  })

  it("returns stable errors for a missing or invalid conversation ID", async () => {
    const harness = await createHarness()

    const missing = await harness.app.inject({
      method: "GET",
      url: "/api/conversations/missing",
    })
    const invalid = await harness.app.inject({
      method: "POST",
      url: "/api/conversations/%20/messages",
      payload: { text: "hello" },
    })
    const omitted = await harness.app.inject({
      method: "POST",
      url: "/api/conversations//cancel",
    })
    const malformed = await harness.app.inject({
      method: "GET",
      url: "/api/conversations/%E0%A4%A",
    })

    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe("conversation_not_found")
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe("invalid_conversation_id")
    expect(omitted.statusCode).toBe(400)
    expect(omitted.json().error.code).toBe("invalid_conversation_id")
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe("invalid_path_parameter")
  })

  it("cancels an active turn and treats an idle cancel as successful", async () => {
    const harness = await createHarness()
    const active = await createConversation(harness)
    const idle = await createConversation(harness)
    await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${active.id}/messages`,
      payload: { text: "hello" },
    })

    const activeResponse = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${active.id}/cancel`,
    })
    const idleResponse = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${idle.id}/cancel`,
    })

    expect(activeResponse.statusCode).toBe(204)
    expect(idleResponse.statusCode).toBe(204)
    expect(harness.adapter.cancelTurnCalls).toEqual(["session-1"])
  })

  it("accepts or declines only a pending approval owned by the conversation", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)
    await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "hello" },
    })
    harness.adapter.emit("session-1", {
      type: "approval_requested",
      request: { id: "approval-1", kind: "command", label: "运行命令" },
    })

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/approvals/approval-1`,
      payload: { decision: "accept" },
    })

    expect(response.statusCode).toBe(204)
    expect(harness.adapter.approvalCalls).toEqual([
      { requestId: "approval-1", decision: "accept" },
    ])

    const expired = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/approvals/approval-1`,
      payload: { decision: "decline" },
    })
    expect(expired.statusCode).toBe(409)
    expect(expired.json().error.code).toBe("approval_expired")
  })

  it.each([
    ["missing", undefined, "invalid_request_body"],
    ["null", null, "invalid_approval_decision"],
    ["unknown", { decision: "always" }, "invalid_approval_decision"],
    ["non-string", { decision: true }, "invalid_approval_decision"],
    [
      "extra fields",
      { decision: "accept", cwd: "/attacker/path" },
      "invalid_approval_decision",
    ],
  ])("rejects an invalid approval body: %s", async (_label, payload, code) => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/approvals/approval-1`,
      headers: { "content-type": "application/json" },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
          }),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(code)
    expect(harness.adapter.approvalCalls).toEqual([])
  })

  it("validates approval path parameters before consulting the service", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/approvals/%20`,
      payload: { decision: "accept" },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("invalid_request_id")
    expect(harness.adapter.approvalCalls).toEqual([])
  })

  it("maps unavailable and unexpected adapter failures without exposing details", async () => {
    const harness = await createHarness()
    harness.adapter.createSessionError = new Error("app_server_exited")
    const unavailable = await harness.app.inject({
      method: "POST",
      url: "/api/conversations",
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({
      error: {
        code: "app_server_exited",
        message: "Agent service is unavailable.",
      },
    })

    harness.adapter.createSessionError = new Error("private provider detail")
    const unexpected = await harness.app.inject({
      method: "POST",
      url: "/api/conversations",
    })
    expect(unexpected.statusCode).toBe(500)
    expect(unexpected.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    })
  })

  it("rejects malformed JSON with the stable error envelope", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { "content-type": "application/json" },
      payload: "{",
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request_body",
        message: "Request body must be valid JSON.",
      },
    })
  })

  it.each([
    [
      "an oversized body",
      "application/json",
      JSON.stringify({ text: "x".repeat(1_100_000) }),
    ],
    ["an unsupported media type", "application/xml", "<text>hello</text>"],
  ])("rejects %s as invalid input", async (_label, contentType, payload) => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { "content-type": contentType },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("invalid_request_body")
    expect(harness.adapter.sendTextCalls).toEqual([])
  })

  it("returns the stable envelope for an unknown API route", async () => {
    const harness = await createHarness()

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/unknown",
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: { code: "route_not_found", message: "Route not found." },
    })
  })
})

describe("SSE transport", () => {
  it("sets strict headers, emits exact frames, and does not replay older events", async () => {
    const harness = await createHarness()
    harness.eventHub.publish("old", { type: "turn_started", turnId: "old-turn" })
    const address = await listen(harness)
    const stream = await openEventStream(harness, address)

    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream")
    expect(stream.response.headers.get("cache-control")).toBe("no-cache")
    expect(stream.response.headers.get("connection")).toBe("keep-alive")
    expect(harness.eventHub.subscriberCount).toBe(1)

    harness.eventHub.publish("c1", {
      type: "text_delta",
      turnId: "t1",
      text: "hello",
    }, { clientRequestId: "client-safe-1" })
    const frame = await readSseFrame(stream.reader)
    const data = JSON.stringify({
      conversationId: "c1",
      clientRequestId: "client-safe-1",
      seq: 2,
      payload: { type: "text_delta", turnId: "t1", text: "hello" },
    })
    expect(frame).toBe(`id: 2\ndata: ${data}\n\n`)

    disconnectEventStream(stream)
    await eventually(() => expect(harness.eventHub.subscriberCount).toBe(0))
  })

  it("a subscriber serialization failure does not block unrelated listeners", async () => {
    const harness = await createHarness()
    const address = await listen(harness)
    const stream = await openEventStream(harness, address)
    const received: unknown[] = []
    harness.eventHub.subscribe((event) => received.push(event))
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() =>
      harness.eventHub.publish(
        "c1",
        cyclic as unknown as ConversationEvent
      )
    ).not.toThrow()
    expect(received).toHaveLength(1)

    disconnectEventStream(stream)
  })

  it("interrupts only when the last SSE client disconnects", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)
    await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "hello" },
    })
    const address = await listen(harness)
    const first = await openEventStream(harness, address)
    const second = await openEventStream(harness, address)
    expect(harness.eventHub.subscriberCount).toBe(2)

    disconnectEventStream(first)
    await eventually(() => expect(harness.eventHub.subscriberCount).toBe(1))
    expect(harness.adapter.cancelTurnCalls).toEqual([])

    disconnectEventStream(second)
    await eventually(() =>
      expect(harness.adapter.cancelTurnCalls).toEqual(["session-1"])
    )
    expect(harness.eventHub.subscriberCount).toBe(0)
  })

  it("server-initiated close unsubscribes clients without cancelling the turn", async () => {
    const harness = await createHarness()
    const conversation = await createConversation(harness)
    await harness.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "hello" },
    })
    const address = await listen(harness)
    await openEventStream(harness, address)

    await harness.closeApp()

    expect(harness.eventHub.subscriberCount).toBe(0)
    expect(harness.adapter.cancelTurnCalls).toEqual([])
  })
})
