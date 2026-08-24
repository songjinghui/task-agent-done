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

function deferredValue<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
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

function event(
  externalSessionId: string,
  payload: ConversationEvent,
  operationId?: string
): AgentAdapterEvent {
  return operationId === undefined
    ? { externalSessionId, payload }
    : { externalSessionId, operationId, payload }
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
  it("normalizes streamed text and compact command status", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")

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
      event("thr_1", { type: "text_delta", turnId: "turn_1", text: "hel" }, "operation-1"),
      event("thr_1", { type: "text_delta", turnId: "turn_1", text: "lo" }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "item_1", label: "运行命令", status: "running" },
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "item_1", label: "运行命令", status: "completed" },
      }, "operation-1"),
    ])
  })

  it("normalizes an unknown tool lifecycle with one sanitized generic identity", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")
    const rawTool = {
      type: "futureSecretTool",
      id: "generic_1",
      path: "/private/workspace/secret.txt",
      command: "cat /private/token",
      payload: { token: "raw-secret" },
    }

    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { ...rawTool, status: "inProgress" },
      })
    )
    fake.emit(
      notification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { ...rawTool, status: "completed" },
      })
    )

    expect(events).toEqual([
      event("thr_1", {
        type: "tool_status",
        tool: { id: "generic_1", label: "使用工具", status: "running" },
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "generic_1", label: "使用工具", status: "completed" },
      }, "operation-1"),
    ])
    expect(JSON.stringify(events)).not.toMatch(
      /futureSecretTool|secret\.txt|private\/token|raw-secret/
    )
  })

  it.each([
    "agentMessage",
    "userMessage",
    "reasoning",
    "plan",
    "hookPrompt",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
  ])("does not render %s items as tools", async (type) => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")

    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { type, id: `excluded_${type}`, status: "inProgress" },
      })
    )
    fake.emit(
      notification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { type, id: `excluded_${type}`, status: "completed" },
      })
    )

    expect(events).toEqual([])
  })

  it("fails a still-running generic tool when its turn terminates", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")

    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "generic_running",
          server: "private-server",
          tool: "private-tool",
        },
      })
    )
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "failed", items: [] },
      })
    )

    expect(
      events.filter(({ payload }) => payload.type === "tool_status")
    ).toEqual([
      event("thr_1", {
        type: "tool_status",
        tool: { id: "generic_running", label: "使用工具", status: "running" },
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "generic_running", label: "使用工具", status: "failed" },
      }, "operation-1"),
    ])
    expect(JSON.stringify(events)).not.toMatch(/private-server|private-tool/)
  })

  it.each([
    { type: "webSearch", completedStatus: undefined, caseName: "statusless webSearch" },
    { type: "imageView", completedStatus: undefined, caseName: "statusless imageView" },
    { type: "webSearch", completedStatus: "futureStatus", caseName: "unknown-status webSearch" },
  ])(
    "treats a completed $caseName notification as authoritative",
    async ({ type, completedStatus }) => {
      const { adapter, events, fake } = setup()
      fake.enqueue("turn/start", { turn: { id: "turn_1" } })
      await adapter.sendText("thr_1", "seed", "operation-1")
      const item = {
        type,
        id: `statusless_${type}`,
        path: "/private/workspace/secret.png",
        query: "private search query",
      }

      fake.emit(
        notification("item/started", {
          threadId: "thr_1",
          turnId: "turn_1",
          item,
        })
      )
      const completedItem: Record<string, unknown> = { ...item }
      if (completedStatus !== undefined) {
        completedItem.status = completedStatus
      }
      fake.emit(
        notification("item/completed", {
          threadId: "thr_1",
          turnId: "turn_1",
          item: completedItem,
        })
      )
      fake.emit(
        notification("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "failed", items: [] },
        })
      )

      expect(
        events.filter(({ payload }) => payload.type === "tool_status")
      ).toEqual([
        event("thr_1", {
          type: "tool_status",
          tool: {
            id: `statusless_${type}`,
            label: "使用工具",
            status: "running",
          },
        }, "operation-1"),
        event("thr_1", {
          type: "tool_status",
          tool: {
            id: `statusless_${type}`,
            label: "使用工具",
            status: "completed",
          },
        }, "operation-1"),
      ])
      expect(JSON.stringify(events)).not.toMatch(/secret\.png|private search query/)
    }
  )

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

    await adapter.sendText("thr_1", "hello", "operation-1")
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
      event("thr_1", { type: "turn_started", turnId: "turn_1" }, "operation-1"),
    ])
  })

  it("buffers a direct terminal notification until its start response is correlated", async () => {
    const { adapter, events, fake } = setup()
    const startResponse = deferredValue<{ turn: { id: string } }>()
    fake.enqueue("turn/start", startResponse.promise)
    const sending = adapter.sendText("thr_1", "hello", "operation-1")
    await Promise.resolve()

    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "failed", items: [] },
      })
    )
    expect(events).toEqual([])

    startResponse.resolve({ turn: { id: "turn_1" } })
    await expect(sending).resolves.toEqual({ turnId: "turn_1" })
    expect(events).toEqual([
      event(
        "thr_1",
        {
          type: "error",
          code: "turn_failed",
          message: "Agent turn failed.",
          terminal: true,
          scope: "turn",
          turnId: "turn_1",
        },
        "operation-1"
      ),
    ])
  })

  it("does not let an old start response or started event replace newer active state", async () => {
    const { adapter, fake } = setup()
    const oldStartResponse = deferredValue<{ turn: { id: string } }>()
    fake.enqueue("turn/start", oldStartResponse.promise)
    const oldSend = adapter.sendText("thr_1", "old", "operation-old")
    await Promise.resolve()

    fake.emit({ type: "exit", code: 17, signal: null, stderr: "" })
    fake.enqueue("turn/start", { turn: { id: "turn-new" } })
    await adapter.sendText("thr_1", "new", "operation-new")

    oldStartResponse.resolve({ turn: { id: "turn-old" } })
    await oldSend
    fake.emit(
      notification("turn/started", {
        threadId: "thr_1",
        turn: { id: "turn-old", status: "inProgress", items: [] },
      })
    )
    fake.enqueue("turn/interrupt", {})
    await adapter.cancelTurn("thr_1")

    expect(fake.requests.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thr_1", turnId: "turn-new" },
    })
  })

  it("does not let an old interrupt rejection clear a newer turn marker", async () => {
    const { adapter, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "first", "operation-1")
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
    await adapter.sendText("thr_1", "second", "operation-2")
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

  it("does not redispatch cancellation after a duplicate started notification", async () => {
    const { adapter, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "hello", "operation-1")
    const interrupt = deferred()
    fake.enqueue("turn/interrupt", interrupt.promise)

    const firstCancel = adapter.cancelTurn("thr_1")
    await Promise.resolve()
    fake.emit(
      notification("turn/started", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "inProgress", items: [] },
      })
    )
    await adapter.cancelTurn("thr_1")

    interrupt.resolve()
    await firstCancel
    expect(fake.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "thr_1", turnId: "turn_1" },
      },
    ])
  })

  it("normalizes failed and declined tools and terminal turn statuses", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed 1", "operation-1")
    fake.enqueue("turn/start", { turn: { id: "turn_2" } })
    await adapter.sendText("thr_2", "seed 2", "operation-2")

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
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_declined", label: "修改文件", status: "declined" },
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_running", label: "修改文件", status: "running" },
      }, "operation-1"),
      event("thr_1", {
        type: "tool_status",
        tool: { id: "file_running", label: "修改文件", status: "failed" },
      }, "operation-1"),
      event("thr_1", { type: "turn_completed", turnId: "turn_1" }, "operation-1"),
      event("thr_2", { type: "turn_interrupted", turnId: "turn_2" }, "operation-2"),
    ])
  })

  it("emits sanitized errors for failed and unsupported terminal turn statuses", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_failed" } })
    await adapter.sendText("thr_failed", "seed failed", "operation-failed")
    fake.enqueue("turn/start", { turn: { id: "turn_unknown" } })
    await adapter.sendText("thr_unknown", "seed unknown", "operation-unknown")

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
      }, "operation-failed"),
      event("thr_unknown", {
        type: "error",
        code: "unsupported_turn_status",
        message: "Agent turn ended with an unsupported status.",
        terminal: true,
        scope: "turn",
        turnId: "turn_unknown",
      }, "operation-unknown"),
    ])
  })

  it("fails every active session and clears transient state when the transport exits", async () => {
    const { adapter, events, fake } = setup()

    for (const suffix of ["1", "2"]) {
      fake.enqueue("turn/start", { turn: { id: `turn_${suffix}` } })
      await adapter.sendText(`thr_${suffix}`, "seed", `operation-${suffix}`)
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
    fake.requests.length = 0

    fake.emit({
      type: "exit",
      code: 17,
      signal: null,
      stderr: "private transport stderr",
    })

    expect(events).toEqual([
      event("thr_1", {
        type: "tool_status",
        tool: { id: "command_1", label: "运行命令", status: "failed" },
      }, "operation-1"),
      event("thr_2", {
        type: "tool_status",
        tool: { id: "command_2", label: "运行命令", status: "failed" },
      }, "operation-2"),
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
    expect(events).toEqual([])
  })

  it("fails an active session with a sanitized protocol error", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")

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
    fake.requests.length = 0

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
    expect(fake.responses).toEqual([
      { id: "wire_1", result: { decision: "decline" } },
    ])

    fake.emit({
      type: "protocol_error",
      message: "invalid_json_rpc_message",
    })
    fake.emit({ type: "exit", code: 1, signal: null, stderr: "" })
    expect(fake.responses).toEqual([
      { id: "wire_1", result: { decision: "decline" } },
    ])
  })

  it("declines a buffered approval when a protocol error invalidates its start", async () => {
    const { adapter, fake } = setup()
    const start = deferredValue<{ turn: { id: string } }>()
    fake.enqueue("turn/start", start.promise)
    const sending = adapter.sendText("thr_1", "seed", "operation-1")

    fake.emit({
      type: "server_request",
      id: "wire_buffered",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "command_1" },
    })
    fake.emit({ type: "protocol_error", message: "invalid_json" })

    expect(fake.responses).toEqual([
      { id: "wire_buffered", result: { decision: "decline" } },
    ])

    fake.emit({ type: "protocol_error", message: "invalid_json" })
    fake.emit({ type: "exit", code: 1, signal: null, stderr: "" })
    expect(fake.responses).toEqual([
      { id: "wire_buffered", result: { decision: "decline" } },
    ])

    start.resolve({ turn: { id: "turn_1" } })
    await sending
  })

  it("normalizes command and file approvals without exposing raw details", async () => {
    const { adapter, events, fake } = setup()
    fake.enqueue("turn/start", { turn: { id: "turn_1" } })
    await adapter.sendText("thr_1", "seed", "operation-1")

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
      }, "operation-1"),
      event("thr_1", {
        type: "approval_requested",
        request: { id: "approval_2", kind: "file_change", label: "修改文件" },
      }, "operation-1"),
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

  it("declines a late approval that cannot be associated with a start", () => {
    const { events, fake } = setup()

    fake.emit({
      type: "server_request",
      id: "wire-late",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_old",
        itemId: "command_old",
      },
    })

    expect(fake.responses).toEqual([
      { id: "wire-late", result: { decision: "decline" } },
    ])
    expect(events).toEqual([])
  })

  it("declines a buffered approval once when its start is rejected", async () => {
    const { adapter, events, fake } = setup()
    const start = deferredValue<{ turn: { id: string } }>()
    fake.enqueue("turn/start", start.promise)
    const sending = adapter.sendText("thr_1", "hello", "operation-1")
    await Promise.resolve()
    fake.emit({
      type: "server_request",
      id: "wire-buffered",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "file_1" },
    })

    start.reject(new Error("start rejected"))
    await expect(sending).rejects.toThrow("start rejected")
    fake.emit({ type: "exit", code: 17, signal: null, stderr: "" })

    expect(fake.responses).toEqual([
      { id: "wire-buffered", result: { decision: "decline" } },
    ])
    expect(events).toEqual([])
    await expect(adapter.respondToApproval("approval_1", "accept")).rejects.toThrow(
      "approval_expired"
    )
  })

  it("does not retain an orphan tool before a later turn association", async () => {
    const { adapter, events, fake } = setup()
    fake.emit(
      notification("item/started", {
        threadId: "thr_1",
        turnId: "turn_reused",
        item: commandItem("orphan_command", "inProgress"),
      })
    )

    fake.enqueue("turn/start", { turn: { id: "turn_reused" } })
    await adapter.sendText("thr_1", "hello", "operation-1")
    fake.emit(
      notification("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_reused", status: "completed", items: [] },
      })
    )

    expect(events).toEqual([
      event(
        "thr_1",
        { type: "turn_completed", turnId: "turn_reused" },
        "operation-1"
      ),
    ])
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
