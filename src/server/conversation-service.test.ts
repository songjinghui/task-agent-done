import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type {
  ApprovalDecision,
  ConversationEvent,
  MessageTurn,
} from "../shared/contracts.js"
import type {
  AgentAdapter,
  AgentAdapterEvent,
} from "./agent/agent-adapter.js"
import {
  ConversationService,
  type ConversationEventSink,
} from "./conversation-service.js"
import { ConversationRepository } from "./conversation-repository.js"
import { openDatabase } from "./database.js"

const databaseDirectories: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

class FakeAgentAdapter implements AgentAdapter {
  readonly createSessionCalls: string[] = []
  readonly readSessionCalls: string[] = []
  readonly resumeSessionCalls: string[] = []
  readonly sendTextCalls: Array<{ externalSessionId: string; text: string }> = []
  readonly cancelTurnCalls: string[] = []
  readonly approvalCalls: Array<{
    requestId: string
    decision: ApprovalDecision
  }> = []
  readonly histories = new Map<string, MessageTurn[]>()

  onResumeSession: (externalSessionId: string) => Promise<void> = async () => {}
  onSendText: (externalSessionId: string, text: string) => Promise<void> =
    async () => {}
  onCancelTurn: (externalSessionId: string) => Promise<void> = async () => {}

  #nextSessionId = 1
  #listeners = new Set<(event: AgentAdapterEvent) => void>()

  async createSession(workspace: string): Promise<{ externalSessionId: string }> {
    this.createSessionCalls.push(workspace)
    return { externalSessionId: `session-${this.#nextSessionId++}` }
  }

  async readSession(externalSessionId: string): Promise<MessageTurn[]> {
    this.readSessionCalls.push(externalSessionId)
    return this.histories.get(externalSessionId) ?? []
  }

  resumeSession(externalSessionId: string): Promise<void> {
    this.resumeSessionCalls.push(externalSessionId)
    return this.onResumeSession(externalSessionId)
  }

  sendText(externalSessionId: string, text: string): Promise<void> {
    this.sendTextCalls.push({ externalSessionId, text })
    return this.onSendText(externalSessionId, text)
  }

  cancelTurn(externalSessionId: string): Promise<void> {
    this.cancelTurnCalls.push(externalSessionId)
    return this.onCancelTurn(externalSessionId)
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
    for (const listener of this.#listeners) {
      listener({ externalSessionId, payload })
    }
  }
}

class RecordingEventSink implements ConversationEventSink {
  readonly events: Array<{
    conversationId: string
    payload: ConversationEvent
  }> = []

  publish(conversationId: string, payload: ConversationEvent): void {
    this.events.push({ conversationId, payload })
  }
}

function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-service-"))
  databaseDirectories.push(directory)
  const database = openDatabase(join(directory, "taskmux.sqlite"))
  databases.push(database)
  const repository = new ConversationRepository(database)
  const adapter = new FakeAgentAdapter()
  const eventSink = new RecordingEventSink()
  const service = new ConversationService({
    repository,
    adapter,
    eventSink,
    workspace: "/fixed/workspace",
  })
  return { adapter, eventSink, repository, service }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("ConversationService", () => {
  it("creates the external session before persisting a TaskMux conversation", async () => {
    const { adapter, repository, service } = createHarness()

    const conversation = await service.create()

    expect(conversation).toMatchObject({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      title: "新会话",
      status: "idle",
    })
    expect(conversation).not.toHaveProperty("externalSessionId")
    expect(adapter.createSessionCalls).toEqual(["/fixed/workspace"])
    expect(repository.getById(conversation.id)?.externalSessionId).toBe(
      "session-1"
    )
    expect(service.list()).toEqual([conversation])
  })

  it("reads adapter history using the stored external session ID", async () => {
    const { adapter, service } = createHarness()
    const conversation = await service.create()
    adapter.histories.set("session-1", [
      { id: "u1", role: "user", text: "hello", status: "completed" },
      {
        id: "a1",
        role: "assistant",
        text: "hi",
        status: "completed",
      },
    ])

    await expect(service.getDetail(conversation.id)).resolves.toEqual({
      conversationId: conversation.id,
      turns: [
        { id: "u1", role: "user", text: "hello", status: "completed" },
        {
          id: "a1",
          role: "assistant",
          text: "hi",
          status: "completed",
        },
      ],
    })
    expect(adapter.readSessionCalls).toEqual(["session-1"])
  })

  it("rejects missing conversation IDs before calling the adapter", async () => {
    const { adapter, service } = createHarness()

    await expect(service.getDetail("missing")).rejects.toMatchObject({
      code: "conversation_not_found",
    })
    await expect(service.sendText("missing", "hello")).rejects.toMatchObject({
      code: "conversation_not_found",
    })
    await expect(service.cancel("missing")).rejects.toMatchObject({
      code: "conversation_not_found",
    })
    await expect(
      service.respondToApproval("missing", "approval-1", "accept")
    ).rejects.toMatchObject({ code: "conversation_not_found" })
    expect(adapter.readSessionCalls).toEqual([])
    expect(adapter.resumeSessionCalls).toEqual([])
    expect(adapter.sendTextCalls).toEqual([])
    expect(adapter.cancelTurnCalls).toEqual([])
  })

  it.each([
    ["blank", " \t\n "],
    ["more than 100,000 Unicode code points", "😀".repeat(100_001)],
  ])("rejects a %s prompt without taking the turn lock", async (_label, text) => {
    const { adapter, service } = createHarness()
    const first = await service.create()
    const second = await service.create()

    await expect(service.sendText(first.id, text)).rejects.toMatchObject({
      code: "invalid_prompt",
    })
    await expect(service.sendText(second.id, "valid")).resolves.toBeUndefined()
    expect(adapter.sendTextCalls).toEqual([
      { externalSessionId: "session-2", text: "valid" },
    ])
  })

  it("takes the global lock before awaiting the adapter", async () => {
    const { adapter, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    const pending = deferred()
    adapter.onSendText = () => pending.promise

    const firstSend = service.sendText(first.id, "first")
    await Promise.resolve()

    await expect(service.sendText(second.id, "second")).rejects.toMatchObject({
      code: "turn_conflict",
    })
    pending.resolve()
    await firstSend
  })

  it("rejects a second global turn and releases the lock on completion", async () => {
    const { adapter, eventSink, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    await service.sendText(first.id, "first")

    await expect(service.sendText(second.id, "second")).rejects.toMatchObject({
      code: "turn_conflict",
    })
    adapter.emit("session-1", { type: "turn_completed", turnId: "t1" })
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()

    expect(repository.getById(first.id)?.status).toBe("idle")
    expect(repository.getById(second.id)?.status).toBe("running")
    expect(eventSink.events).toEqual([
      {
        conversationId: first.id,
        payload: { type: "turn_completed", turnId: "t1" },
      },
    ])
  })

  it.each([
    [
      "interruption",
      { type: "turn_interrupted", turnId: "t1" } as const,
      "interrupted",
    ],
    [
      "adapter error",
      { type: "error", code: "app_server_exited", message: "exited" } as const,
      "failed",
    ],
  ])("releases the global lock on %s", async (_label, payload, status) => {
    const { adapter, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    await service.sendText(first.id, "first")

    adapter.emit("session-1", payload)

    expect(repository.getById(first.id)?.status).toBe(status)
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("does not let a stale turn completion release current ownership", async () => {
    const { adapter, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    await service.sendText(first.id, "first")
    adapter.emit("session-1", { type: "turn_started", turnId: "current" })

    adapter.emit("session-1", { type: "turn_completed", turnId: "stale" })

    await expect(service.sendText(second.id, "second")).rejects.toMatchObject({
      code: "turn_conflict",
    })
    adapter.emit("session-1", { type: "turn_completed", turnId: "current" })
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("marks a failed send and releases exactly that turn ownership", async () => {
    const { adapter, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    adapter.onSendText = async () => {
      throw new Error("turn start failed")
    }

    await expect(service.sendText(first.id, "first")).rejects.toThrow(
      "turn start failed"
    )
    expect(repository.getById(first.id)).toMatchObject({
      title: "新会话",
      status: "failed",
    })

    adapter.onSendText = async () => {}
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("releases the lock when resuming a session fails", async () => {
    const { adapter, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    adapter.onResumeSession = async () => {
      throw new Error("resume failed")
    }

    await expect(service.sendText(first.id, "first")).rejects.toThrow(
      "resume failed"
    )
    expect(repository.getById(first.id)?.status).toBe("failed")

    adapter.onResumeSession = async () => {}
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("generates a 60-code-point title only after the first send is accepted", async () => {
    const { adapter, repository, service } = createHarness()
    const conversation = await service.create()
    const firstPrompt = `  ${"a".repeat(59)}😀ignored   words  `

    await service.sendText(conversation.id, firstPrompt)

    expect(repository.getById(conversation.id)?.title).toBe(
      `${"a".repeat(59)}😀`
    )
    adapter.emit("session-1", { type: "turn_completed", turnId: "t1" })
    await service.sendText(conversation.id, "replacement title")
    expect(repository.getById(conversation.id)?.title).toBe(
      `${"a".repeat(59)}😀`
    )
  })

  it("makes cancellation idempotent for idle and active conversations", async () => {
    const { adapter, service } = createHarness()
    const conversation = await service.create()

    await service.cancel(conversation.id)
    await service.cancel(conversation.id)
    expect(adapter.cancelTurnCalls).toEqual([])

    await service.sendText(conversation.id, "hello")
    await service.cancel(conversation.id)
    await service.cancel(conversation.id)
    expect(adapter.cancelTurnCalls).toEqual(["session-1"])
  })

  it("forwards approval decisions only for their owning conversation", async () => {
    const { adapter, service } = createHarness()
    const owner = await service.create()
    const other = await service.create()
    adapter.emit("session-1", {
      type: "approval_requested",
      request: {
        id: "approval-1",
        kind: "command",
        label: "Run command",
      },
    })

    await expect(
      service.respondToApproval(other.id, "approval-1", "decline")
    ).rejects.toMatchObject({ code: "approval_expired" })
    expect(adapter.approvalCalls).toEqual([])

    await service.respondToApproval(owner.id, "approval-1", "decline")

    expect(adapter.approvalCalls).toEqual([
      { requestId: "approval-1", decision: "decline" },
    ])
    await expect(
      service.respondToApproval(owner.id, "approval-1", "accept")
    ).rejects.toMatchObject({ code: "approval_expired" })
  })

  it("marks stale running rows interrupted during startup recovery", () => {
    const { repository, service } = createHarness()
    repository.create({ id: "stale", externalSessionId: "existing-session" })
    repository.setStatus("stale", "running")

    expect(service.recoverStartup()).toBe(1)
    expect(repository.getById("stale")?.status).toBe("interrupted")
    expect(service.recoverStartup()).toBe(0)
  })

  it("interrupts the owned active turn once when the client disconnects", async () => {
    const { adapter, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    await service.sendText(first.id, "first")

    await service.handleClientDisconnect()
    await service.handleClientDisconnect()

    expect(adapter.cancelTurnCalls).toEqual(["session-1"])
    adapter.emit("session-1", { type: "turn_interrupted", turnId: "t1" })
    expect(repository.getById(first.id)?.status).toBe("interrupted")
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("defers disconnect cancellation until a pending turn start is accepted", async () => {
    const { adapter, service } = createHarness()
    const conversation = await service.create()
    const pending = deferred()
    adapter.onSendText = () => pending.promise
    const send = service.sendText(conversation.id, "hello")
    await Promise.resolve()

    await service.handleClientDisconnect()
    expect(adapter.cancelTurnCalls).toEqual([])

    pending.resolve()
    await send
    expect(adapter.cancelTurnCalls).toEqual(["session-1"])
  })

  it("keeps global ownership after cancellation failure until a terminal event", async () => {
    const { adapter, eventSink, repository, service } = createHarness()
    const first = await service.create()
    const second = await service.create()
    await service.sendText(first.id, "first")
    adapter.onCancelTurn = async () => {
      throw new Error("cancel failed")
    }

    await expect(service.cancel(first.id)).rejects.toThrow("cancel failed")

    expect(repository.getById(first.id)?.status).toBe("running")
    expect(eventSink.events).toEqual([
      {
        conversationId: first.id,
        payload: {
          type: "error",
          code: "turn_cancel_failed",
          message: "Failed to cancel the active turn.",
        },
      },
    ])
    await expect(service.sendText(second.id, "second")).rejects.toMatchObject({
      code: "turn_conflict",
    })

    adapter.emit("session-1", { type: "turn_interrupted", turnId: "t1" })
    await expect(service.sendText(second.id, "second")).resolves.toBeUndefined()
  })

  it("ignores adapter events for sessions outside the repository", () => {
    const { adapter, eventSink } = createHarness()

    adapter.emit("unknown-session", {
      type: "error",
      code: "app_server_exited",
      message: "exited",
    })

    expect(eventSink.events).toEqual([])
  })
})
