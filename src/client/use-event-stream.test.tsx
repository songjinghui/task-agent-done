import "@testing-library/jest-dom/vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ApprovalRequest,
  ConversationEvent,
  ConversationEventEnvelope,
  ConversationSummary,
} from "../shared/contracts.js"
import {
  conversationReducer,
  initialConversationState,
  isAnyConversationRunning,
  selectApproval,
  selectDisplayedTurns,
  selectLiveText,
  selectTools,
  type ConversationAction,
  type ConversationState,
} from "./conversation-store.js"
import { useEventStream } from "./use-event-stream.js"

const first: ConversationSummary = {
  id: "c1",
  title: "第一个会话",
  status: "idle",
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:10:00.000Z",
}

const second: ConversationSummary = {
  ...first,
  id: "c2",
  title: "第二个会话",
}

afterEach(cleanup)

describe("live conversation reducer", () => {
  it("appends text deltas and replaces a tool by its stable ID", () => {
    let state = loadedState()
    state = receive(state, 1, "c1", {
      type: "text_delta",
      turnId: "t1",
      text: "hel",
    })
    state = receive(state, 2, "c1", {
      type: "text_delta",
      turnId: "t1",
      text: "lo",
    })
    state = receive(state, 3, "c1", {
      type: "tool_status",
      tool: { id: "tool1", label: "运行命令", status: "running" },
    })
    state = receive(state, 4, "c1", {
      type: "tool_status",
      tool: { id: "tool1", label: "运行命令", status: "completed" },
    })

    expect(selectLiveText(state, "c1", "t1")).toBe("hello")
    expect(selectTools(state, "c1")).toEqual([
      { id: "tool1", label: "运行命令", status: "completed" },
    ])
  })

  it("ignores duplicate and globally out-of-order seq while updating an unselected conversation", () => {
    let state = loadedState()
    state = receive(state, 7, "c2", { type: "turn_started", turnId: "t2" })
    state = receive(state, 7, "c2", {
      type: "text_delta",
      turnId: "t2",
      text: "duplicate",
    })
    state = receive(state, 6, "c1", {
      type: "text_delta",
      turnId: "t1",
      text: "old",
    })

    expect(state.selectedId).toBe("c1")
    expect(state.lastEventSeq).toBe(7)
    expect(selectLiveText(state, "c2", "t2")).toBe("")
    expect(state.summariesById.c2?.status).toBe("running")
    expect(isAnyConversationRunning(state)).toBe(true)
  })

  it("preserves a live running status when the initial list resolves afterward", () => {
    let state = receive(initialConversationState, 1, "c2", {
      type: "turn_started",
      turnId: "t2",
    })
    state = conversationReducer(state, {
      type: "listSucceeded",
      workspace: "/work/taskmux",
      conversations: [first, second],
    })

    expect(state.summariesById.c2?.status).toBe("running")
    expect(isAnyConversationRunning(state)).toBe(true)
  })

  it("temporarily merges completed assistant text exactly once and clears turn UI", () => {
    let state = loadedState()
    state = receive(state, 1, "c1", { type: "turn_started", turnId: "t1" })
    state = receive(state, 2, "c1", {
      type: "text_delta",
      turnId: "t1",
      text: "完成回答",
    })
    state = receive(state, 3, "c1", tool("tool1", "running"))
    state = receive(state, 4, "c1", approval("a1"))
    state = receive(state, 5, "c1", { type: "turn_completed", turnId: "t1" })

    expect(selectDisplayedTurns(state, "c1")).toEqual([
      {
        id: "t1",
        role: "assistant",
        text: "完成回答",
        status: "completed",
      },
    ])
    expect(selectLiveText(state, "c1", "t1")).toBe("")
    expect(selectTools(state, "c1")).toEqual([])
    expect(selectApproval(state, "c1")).toBeNull()
    expect(state.summariesById.c1?.status).toBe("idle")
    expect(isAnyConversationRunning(state)).toBe(false)

    state = {
      ...state,
      detailsById: {
        c1: {
          conversationId: "c1",
          turns: [
            {
              id: "t1",
              role: "assistant",
              text: "完成回答",
              status: "completed",
            },
          ],
        },
      },
    }
    expect(selectDisplayedTurns(state, "c1")).toHaveLength(1)
  })

  it.each([
    {
      name: "interruption",
      event: { type: "turn_interrupted", turnId: "t1" } as const,
      status: "interrupted" as const,
    },
    {
      name: "turn error",
      event: {
        type: "error",
        code: "turn_start_failed",
        message: "无法继续",
        terminal: true,
        scope: "turn",
        turnId: "t1",
      } as const,
      status: "failed" as const,
    },
    {
      name: "session error",
      event: {
        type: "error",
        code: "app_server_exited",
        message: "服务已退出",
        terminal: true,
        scope: "session",
      } as const,
      status: "failed" as const,
    },
  ])("clears active UI on terminal $name", ({ event, status }) => {
    let state = loadedState()
    state = receive(state, 1, "c1", { type: "turn_started", turnId: "t1" })
    state = receive(state, 2, "c1", tool("tool1", "running"))
    state = receive(state, 3, "c1", approval("a1"))
    state = receive(state, 4, "c1", event)

    expect(state.summariesById.c1?.status).toBe(status)
    expect(selectTools(state, "c1")).toEqual([])
    expect(selectApproval(state, "c1")).toBeNull()
    expect(isAnyConversationRunning(state)).toBe(false)
  })

  it("expires only the matching approval without leaking request fields", () => {
    let state = loadedState()
    state = receive(state, 1, "c1", approval("a1"))
    state = receive(state, 2, "c1", {
      type: "error",
      code: "approval_expired",
      message: "Approval expired.",
      terminal: false,
    })

    expect(selectApproval(state, "c1")).toBeNull()
    expect(state.liveByConversationId.c1?.error).toBe("Approval expired.")
  })

  it("rolls back only an unaccepted optimistic send", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-1",
      text: "先显示",
    })
    expect(selectDisplayedTurns(state, "c1").at(-1)?.text).toBe("先显示")
    expect(isAnyConversationRunning(state)).toBe(true)

    state = conversationReducer(state, {
      type: "sendRejected",
      conversationId: "c1",
      requestId: "send-1",
      message: "发送失败",
    })
    expect(selectDisplayedTurns(state, "c1")).toEqual([])
    expect(state.summariesById.c1?.status).toBe("idle")

    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-2",
      text: "已被服务接受",
    })
    state = receive(state, 10, "c1", { type: "turn_started", turnId: "t2" })
    state = conversationReducer(state, {
      type: "sendRejected",
      conversationId: "c1",
      requestId: "send-2",
      message: "响应丢失",
    })
    expect(selectDisplayedTurns(state, "c1").at(-1)?.text).toBe(
      "已被服务接受"
    )
    expect(isAnyConversationRunning(state)).toBe(true)
  })
})

describe("useEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal("EventSource", FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("uses one auto-reconnecting EventSource, reports status, and closes on cleanup", () => {
    const dispatch = vi.fn<(action: ConversationAction) => void>()
    const view = render(<StreamProbe dispatch={dispatch} />)
    const source = FakeEventSource.instances[0]!

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(source.url).toBe("/api/events")
    expect(screen.getByRole("status")).toHaveTextContent("connecting")

    act(() => source.open())
    expect(screen.getByRole("status")).toHaveTextContent("connected")
    act(() => source.fail())
    expect(screen.getByRole("status")).toHaveTextContent("disconnected")
    expect(FakeEventSource.instances).toHaveLength(1)
    act(() => source.open())
    expect(screen.getByRole("status")).toHaveTextContent("connected")

    view.unmount()
    expect(source.closed).toBe(true)
  })

  it("validates and sanitizes events, ignores malformed frames, and deduplicates seq", () => {
    const dispatch = vi.fn<(action: ConversationAction) => void>()
    render(<StreamProbe dispatch={dispatch} />)
    const source = FakeEventSource.instances[0]!

    act(() => {
      source.message("not json")
      source.message(JSON.stringify({ conversationId: "c1", seq: 1 }))
      source.message(
        JSON.stringify({
          conversationId: "c1",
          seq: 4,
          operationId: "must-not-enter-client",
          payload: {
            type: "text_delta",
            turnId: "t1",
            text: "hello",
            rawProvider: { method: "item/agentMessage/delta" },
          },
        })
      )
      source.message(
        JSON.stringify({
          conversationId: "c1",
          seq: 4,
          payload: { type: "turn_completed", turnId: "t1" },
        })
      )
      source.message(
        JSON.stringify({
          conversationId: "c1",
          seq: 3,
          payload: { type: "turn_interrupted", turnId: "t1" },
        })
      )
    })

    const events = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "eventReceived")
    expect(events).toEqual([
      {
        type: "eventReceived",
        envelope: {
          conversationId: "c1",
          seq: 4,
          payload: { type: "text_delta", turnId: "t1", text: "hello" },
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain("operationId")
    expect(JSON.stringify(events)).not.toContain("rawProvider")
  })
})

function StreamProbe({
  dispatch,
}: {
  dispatch(action: ConversationAction): void
}) {
  const stream = useEventStream(dispatch)
  return <div role="status">{stream.status}</div>
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  open(): void {
    this.onopen?.()
  }

  fail(): void {
    this.onerror?.()
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  close(): void {
    this.closed = true
  }
}

function loadedState(): ConversationState {
  return conversationReducer(initialConversationState, {
    type: "listSucceeded",
    workspace: "/work/taskmux",
    conversations: [first, second],
  })
}

function receive(
  state: ConversationState,
  seq: number,
  conversationId: string,
  payload: ConversationEvent
): ConversationState {
  const envelope: ConversationEventEnvelope = {
    conversationId,
    seq,
    payload,
  }
  return conversationReducer(state, { type: "eventReceived", envelope })
}

function tool(
  id: string,
  status: "running" | "completed" | "failed" | "declined"
): ConversationEvent {
  return {
    type: "tool_status",
    tool: { id, label: "运行命令", status },
  }
}

function approval(id: string): ConversationEvent {
  const request: ApprovalRequest = {
    id,
    kind: "command",
    label: "运行命令 secret payload",
  }
  return { type: "approval_requested", request }
}
