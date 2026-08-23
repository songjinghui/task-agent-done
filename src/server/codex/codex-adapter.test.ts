import { describe, expect, it } from "vitest"
import type { ConversationEvent } from "../../shared/contracts.js"
import type { AgentAdapterEvent } from "../agent/agent-adapter.js"
import { CodexAppServerAdapter } from "./codex-adapter.js"
import type {
  CodexJsonRpcClient,
  CodexJsonRpcClientEvent,
  JsonRpcId,
} from "./json-rpc-client.js"

type RequestCall = { method: string; params: unknown }
type ResponseCall = { id: JsonRpcId; result: unknown }

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

class FakeCodexClient {
  readonly requests: RequestCall[] = []
  readonly responses: ResponseCall[] = []
  readonly #listeners = new Set<(event: CodexJsonRpcClientEvent) => void>()
  readonly #results = new Map<string, unknown[]>()

  enqueue(method: string, result: unknown): void {
    const results = this.#results.get(method) ?? []
    results.push(result)
    this.#results.set(method, results)
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    const results = this.#results.get(method)
    if (!results?.length) throw new Error(`No fake result for ${method}`)
    return results.shift() as T
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.responses.push({ id, result })
  }

  subscribe(listener: (event: CodexJsonRpcClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: CodexJsonRpcClientEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function setup(): {
  adapter: CodexAppServerAdapter
  events: AgentAdapterEvent[]
  fake: FakeCodexClient
} {
  const fake = new FakeCodexClient()
  const adapter = new CodexAppServerAdapter(fake as unknown as CodexJsonRpcClient)
  const events: AgentAdapterEvent[] = []
  adapter.subscribe((event) => events.push(event))
  return { adapter, events, fake }
}

function event(externalSessionId: string, payload: ConversationEvent): AgentAdapterEvent {
  return { externalSessionId, payload }
}

function notification(method: string, params: unknown): CodexJsonRpcClientEvent {
  return { type: "notification", method, params }
}

function agentDelta(threadId: string, turnId: string, delta: string): CodexJsonRpcClientEvent {
  return notification("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: "message_1",
    delta,
  })
}

function commandItem(id: string, status: string) {
  return {
    type: "commandExecution",
    id,
    command: "pnpm test",
    cwd: "/private/workspace",
    status,
  }
}

function fileItem(id: string, status: string) {
  return {
    type: "fileChange",
    id,
    changes: [{ path: "/private/workspace/secret.txt", kind: "update" }],
    status,
  }
}

describe("CodexAppServerAdapter", () => {
  it("normalizes streamed text and compact command status", () => {
    const { events, fake } = setup()

    fake.emit(agentDelta("thr_1", "turn_1", "hel"))
    fake.emit(agentDelta("thr_1", "turn_1", "lo"))
    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: commandItem("item_1", "inProgress"),
      })
    )
    fake.emit(
      notification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: commandItem("item_1", "completed"),
      })
    )

    expect(events).toEqual([
      event("thr_1", { type: "text_delta", turnId: "turn_1", text: "hel" }),
      event("thr_1", { type: "text_delta", turnId: "turn_1", text: "lo" }),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "item_1", label: "运行命令", status: "running" },
      }),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "item_1", label: "运行命令", status: "completed" },
      }),
    ])
  })

  it("maps session methods and projects only user and assistant history", async () => {
    const { adapter, fake } = setup()
    fake.enqueue("thread/start", { thread: { id: "thr_1" } })
    fake.enqueue("thread/read", {
      thread: {
        id: "thr_1",
        turns: [
          {
            id: "turn_1",
            status: "completed",
            items: [
              {
                type: "userMessage",
                id: "user_1",
                clientId: null,
                content: [
                  { type: "text", text: "hello", text_elements: [] },
                  { type: "localImage", path: "/private/image.png" },
                  { type: "text", text: " world", text_elements: [] },
                ],
              },
              { type: "reasoning", id: "reason_1", summary: [], content: [] },
              {
                type: "agentMessage",
                id: "assistant_1",
                text: "Hi there",
                phase: "final_answer",
                memoryCitation: null,
              },
            ],
          },
          {
            id: "turn_2",
            status: "failed",
            items: [
              {
                type: "agentMessage",
                id: "assistant_2",
                text: "partial",
                phase: null,
                memoryCitation: null,
              },
            ],
          },
          {
            id: "turn_3",
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                id: "user_3",
                clientId: null,
                content: [{ type: "text", text: "unfinished", text_elements: [] }],
              },
            ],
          },
        ],
      },
    })
    fake.enqueue("thread/resume", { thread: { id: "thr_1" } })

    await expect(adapter.createSession("/workspace")).resolves.toEqual({
      externalSessionId: "thr_1",
    })
    await expect(adapter.readSession("thr_1")).resolves.toEqual([
      { id: "user_1", role: "user", text: "hello world", status: "completed" },
      {
        id: "assistant_1",
        role: "assistant",
        text: "Hi there",
        status: "completed",
      },
      { id: "assistant_2", role: "assistant", text: "partial", status: "failed" },
      { id: "user_3", role: "user", text: "unfinished", status: "interrupted" },
    ])
    await adapter.resumeSession("thr_1")

    expect(fake.requests).toEqual([
      {
        method: "thread/start",
        params: { cwd: "/workspace", serviceName: "taskmux" },
      },
      {
        method: "thread/read",
        params: { threadId: "thr_1", includeTurns: true },
      },
      { method: "thread/resume", params: { threadId: "thr_1" } },
    ])
  })

  it("starts one text input item and interrupts the active turn", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    fake.enqueue("turn/interrupt", {})

    await adapter.sendText("thr_1", "hello")
    fake.emit(
      notification("turn/started", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "inProgress", items: [] },
      })
    )
    await adapter.cancelTurn("thr_1")

    expect(fake.requests).toEqual([
      {
        method: "turn/start",
        params: {
          threadId: "thr_1",
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_1" },
      },
    ])
    expect(events).toEqual([
      event("thr_1", { type: "turn_started", turnId: "turn_1" }),
    ])
  })

  it("does not let an old interrupt rejection clear a newer turn marker", async () => {
    const { adapter, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "first")
    const oldInterrupt = deferred()
    fake.enqueue("turn/interrupt", oldInterrupt.promise)
    const firstCancel = adapter.cancelTurn("thr_1")
    await Promise.resolve()

    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "interrupted", items: [] },
      })
    )
    fake.enqueue("turn/start", { turn: { id: "turn_2" } })
    await adapter.sendText("thr_1", "second")
    const currentInterrupt = deferred()
    fake.enqueue("turn/interrupt", currentInterrupt.promise)
    fake.enqueue("turn/interrupt", currentInterrupt.promise)
    const secondCancel = adapter.cancelTurn("thr_1")
    await Promise.resolve()

    oldInterrupt.reject(new Error("old interrupt failed"))
    await expect(firstCancel).rejects.toThrow("old interrupt failed")
    const duplicateCancel = adapter.cancelTurn("thr_1")
    await Promise.resolve()
    currentInterrupt.resolve()
    await Promise.all([secondCancel, duplicateCancel])

    expect(fake.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_1" },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_2" },
      },
    ])
  })

  it("normalizes failed and declined tools and terminal turn statuses", () => {
    const { events, fake } = setup()

    fake.emit(
      notification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: commandItem("command_failed", "failed"),
      })
    )
    fake.emit(
      notification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: fileItem("file_declined", "declined"),
      })
    )
    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: fileItem("file_running", "inProgress"),
      })
    )
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed", items: [] },
      })
    )
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_2",
        turn: { id: "turn_2", status: "interrupted", items: [] },
      })
    )

    expect(events).toEqual([
      event("thr_1", {
        type: "tool_status",
        tool: { id: "command_failed", label: "运行命令", status: "failed" },
      }),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_declined", label: "修改文件", status: "declined" },
      }),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_running", label: "修改文件", status: "running" },
      }),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_running", label: "修改文件", status: "failed" },
      }),
      event("thr_1", { type: "turn_completed", turnId: "turn_1" }),
      event("thr_2", { type: "turn_interrupted", turnId: "turn_2" }),
    ])
  })

  it("emits sanitized errors for failed and unsupported terminal turn statuses", () => {
    const { events, fake } = setup()

    fake.emit(
      notification("turn/completed", {
        threadId: "thr_failed",
        turn: {
          id: "turn_failed",
          status: "failed",
          items: [],
          error: { message: "private provider failure detail" },
        },
      })
    )
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_unknown",
        turn: {
          id: "turn_unknown",
          status: "providerSpecificStatus",
          items: [],
          privatePayload: "must not escape",
        },
      })
    )

    expect(events).toEqual([
      event("thr_failed", {
        type: "error",
        code: "turn_failed",
        message: "Agent turn failed.",
        terminal: true,
        scope: "turn",
        turnId: "turn_failed",
      }),
      event("thr_unknown", {
        type: "error",
        code: "unsupported_turn_status",
        message: "Agent turn ended with an unsupported status.",
        terminal: true,
        scope: "turn",
        turnId: "turn_unknown",
      }),
    ])
  })

  it("fails every active session and clears transient state when the transport exits", async () => {
    const { adapter, events, fake } = setup()

    for (const suffix of ["1", "2"]) {
      fake.emit(
        notification("turn/started", {
          threadId: `thr_${suffix}`,
          turn: { id: `turn_${suffix}`, status: "inProgress", items: [] },
        })
      )
      fake.emit(
        notification("item/started", {
          threadId: `thr_${suffix}`,
          turnId: `turn_${suffix}`,
          item: commandItem(`command_${suffix}`, "inProgress"),
        })
      )
      fake.emit({
        type: "server_request",
        id: `wire_${suffix}`,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: `thr_${suffix}`,
          turnId: `turn_${suffix}`,
          itemId: `command_${suffix}`,
        },
      })
    }
    events.length = 0

    fake.emit({
      type: "exit",
      code: 17,
      signal: null,
      stderr: "private transport stderr",
    })

    expect(events).toEqual([
      event("thr_1", {
        type: "error",
        code: "app_server_exited",
        message: "Agent server exited unexpectedly.",
        terminal: true,
        scope: "session",
      }),
      event("thr_2", {
        type: "error",
        code: "app_server_exited",
        message: "Agent server exited unexpectedly.",
        terminal: true,
        scope: "session",
      }),
    ])
    expect(JSON.stringify(events)).not.toContain("private transport stderr")
    await expect(adapter.respondToApproval("approval_1", "accept")).rejects.toThrow(
      "approval_expired"
    )
    await expect(adapter.respondToApproval("approval_2", "accept")).rejects.toThrow(
      "approval_expired"
    )
    await adapter.cancelTurn("thr_1")
    await adapter.cancelTurn("thr_2")
    expect(fake.requests).toEqual([])

    events.length = 0
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed", items: [] },
      })
    )
    expect(events).toEqual([
      event("thr_1", { type: "turn_completed", turnId: "turn_1" }),
    ])
  })

  it("fails an active session with a sanitized protocol error", async () => {
    const { adapter, events, fake } = setup()

    fake.emit(
      notification("turn/started", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "inProgress", items: [] },
      })
    )
    fake.emit({
      type: "server_request",
      id: "wire_1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "file_1" },
    })
    events.length = 0

    fake.emit({
      type: "protocol_error",
      message: "invalid_json",
      raw: "private malformed provider payload",
    })

    expect(events).toEqual([
      event("thr_1", {
        type: "error",
        code: "app_server_protocol_error",
        message: "Agent server protocol error.",
        terminal: true,
        scope: "session",
      }),
    ])
    expect(JSON.stringify(events)).not.toContain("private malformed provider payload")
    await expect(adapter.respondToApproval("approval_1", "decline")).rejects.toThrow(
      "approval_expired"
    )
    await adapter.cancelTurn("thr_1")
    expect(fake.requests).toEqual([])
  })

  it("normalizes command and file approvals without exposing raw details", async () => {
    const { adapter, events, fake } = setup()

    fake.emit({
      type: "server_request",
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "command_1",
        command: "cat /private/token",
        cwd: "/private/workspace",
      },
    })
    fake.emit({
      type: "server_request",
      id: "wire-file-1",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "file_1",
        grantRoot: "/private/workspace",
      },
    })

    expect(events).toEqual([
      event("thr_1", {
        type: "approval_requested",
        request: { id: "approval_1", kind: "command", label: "运行命令" },
      }),
      event("thr_1", {
        type: "approval_requested",
        request: { id: "approval_2", kind: "file_change", label: "修改文件" },
      }),
    ])

    await adapter.respondToApproval("approval_1", "accept")
    await adapter.respondToApproval("approval_2", "decline")

    expect(fake.responses).toEqual([
      { id: 41, result: { decision: "accept" } },
      { id: "wire-file-1", result: { decision: "decline" } },
    ])
    await expect(adapter.respondToApproval("approval_1", "accept")).rejects.toThrow(
      "approval_expired"
    )
    await expect(adapter.respondToApproval("missing", "decline")).rejects.toThrow(
      "approval_expired"
    )
  })

  it("safely declines unknown server interactions and reports them", () => {
    const { events, fake } = setup()

    fake.emit({
      type: "server_request",
      id: "unknown_1",
      method: "item/tool/requestUserInput",
      params: { threadId: "thr_9", turnId: "turn_9", questions: [] },
    })

    expect(fake.responses).toEqual([
      { id: "unknown_1", result: { decision: "decline" } },
    ])
    expect(events).toEqual([
      event("thr_9", {
        type: "error",
        code: "unsupported_interaction",
        message: "Agent requested an unsupported interaction.",
        terminal: false,
      }),
    ])
  })
})
