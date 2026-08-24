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
  isConversationActive,
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

  it("requests selected terminal history sync once per epoch and turn identity", () => {
    let state = loadedState()
    state = receive(state, 1, "c1", { type: "turn_started", turnId: "t1" })
    state = receive(state, 2, "c1", { type: "turn_completed", turnId: "t1" })
    expect(state.detailLoadGeneration).toBe(1)

    state = receive(state, 3, "c1", {
      type: "turn_completed",
      turnId: "t1",
    })
    expect(state.detailLoadGeneration).toBe(1)

    state = conversationReducer(state, { type: "streamReopened", epoch: 1 })
    expect(state.detailLoadGeneration).toBe(2)
    state = receive(state, 1, "c1", {
      type: "turn_completed",
      turnId: "t1",
    })
    expect(state.detailLoadGeneration).toBe(3)
  })

  it("retires transient user and assistant turns after refreshed history uses different item IDs", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-1",
      text: "相同问题",
    })
    state = receive(
      state,
      1,
      "c1",
      { type: "turn_started", turnId: "t1" },
      "send-1"
    )
    state = receive(
      state,
      2,
      "c1",
      { type: "text_delta", turnId: "t1", text: "相同回答" },
      "send-1"
    )
    state = receive(
      state,
      3,
      "c1",
      { type: "turn_completed", turnId: "t1" },
      "send-1"
    )
    state = conversationReducer(state, {
      type: "detailRequested",
      conversationId: "c1",
      requestId: 1,
    })
    state = conversationReducer(state, {
      type: "detailSucceeded",
      conversationId: "c1",
      requestId: 1,
      detail: {
        conversationId: "c1",
        turns: [
          { id: "codex-user-item", role: "user", text: "相同问题", status: "completed" },
          {
            id: "codex-assistant-item",
            role: "assistant",
            text: "相同回答",
            status: "completed",
          },
        ],
      },
    })

    expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
      "相同问题",
      "相同回答",
    ])
  })

  it("preserves the optimistic user entry needed by a still-active turn during history reload", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-active",
      text: "仍在运行的问题",
    })
    state = receive(state, 1, "c1", {
      type: "turn_started",
      turnId: "active-turn",
    })
    state = receive(state, 2, "c1", {
      type: "text_delta",
      turnId: "active-turn",
      text: "部分回答",
    })
    state = conversationReducer(state, {
      type: "detailRequested",
      conversationId: "c1",
      requestId: 1,
    })
    state = conversationReducer(state, {
      type: "detailSucceeded",
      conversationId: "c1",
      requestId: 1,
      detail: { conversationId: "c1", turns: [] },
    })

    expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
      "仍在运行的问题",
    ])
    expect(selectLiveText(state, "c1", "active-turn")).toBe("部分回答")
    expect(isAnyConversationRunning(state)).toBe(true)
  })

  it.each([
    {
      evidence: "tool",
      event: tool("accepted-tool", "running"),
      settleHttp: false,
    },
    {
      evidence: "tool",
      event: tool("accepted-tool", "running"),
      settleHttp: true,
    },
    {
      evidence: "approval",
      event: approval("accepted-approval"),
      settleHttp: false,
    },
    {
      evidence: "approval",
      event: approval("accepted-approval"),
      settleHttp: true,
    },
  ])(
    "keeps a $evidence-accepted optimistic user while running after HTTP settled=$settleHttp and selection reload",
    ({ event, settleHttp }) => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-owned",
        text: "仍属于运行中 turn 的问题",
      })
      state = receive(state, 1, "c1", event, "send-owned")
      if (settleHttp) {
        state = conversationReducer(state, {
          type: "sendAccepted",
          conversationId: "c1",
          requestId: "send-owned",
        })
      }
      state = conversationReducer(state, {
        type: "selected",
        conversationId: "c2",
      })
      state = conversationReducer(state, {
        type: "selected",
        conversationId: "c1",
      })
      state = conversationReducer(state, {
        type: "detailRequested",
        conversationId: "c1",
        requestId: 1,
      })
      state = conversationReducer(state, {
        type: "detailSucceeded",
        conversationId: "c1",
        requestId: 1,
        detail: { conversationId: "c1", turns: [] },
      })

      expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
        "仍属于运行中 turn 的问题",
      ])
      expect(state.summariesById.c1?.status).toBe("running")
    }
  )

  it("keeps a new accepted attempt independent from a prior terminal attempt", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-old",
      text: "旧问题",
    })
    state = receive(
      state,
      1,
      "c1",
      approval("old-approval"),
      "send-old"
    )
    state = conversationReducer(state, {
      type: "sendAccepted",
      conversationId: "c1",
      requestId: "send-old",
    })
    state = receive(
      state,
      2,
      "c1",
      { type: "turn_completed", turnId: "old-turn" },
      "send-old"
    )
    state = conversationReducer(state, {
      type: "detailRequested",
      conversationId: "c1",
      requestId: 1,
    })
    state = conversationReducer(state, {
      type: "detailFailed",
      conversationId: "c1",
      requestId: 1,
      message: "暂时失败",
    })

    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-new",
      text: "新问题",
    })
    state = receive(state, 3, "c1", tool("new-tool", "running"), "send-new")
    state = conversationReducer(state, {
      type: "detailRequested",
      conversationId: "c1",
      requestId: 2,
    })
    state = conversationReducer(state, {
      type: "detailSucceeded",
      conversationId: "c1",
      requestId: 2,
      detail: {
        conversationId: "c1",
        turns: [
          {
            id: "codex-old-user",
            role: "user",
            text: "旧问题",
            status: "completed",
          },
        ],
      },
    })

    expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
      "旧问题",
      "新问题",
    ])
  })

  it("does not carry accepted optimistic ownership into a new stream epoch", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-before-reopen",
      text: "重连前问题",
    })
    state = receive(
      state,
      1,
      "c1",
      tool("before-reopen-tool", "running"),
      "send-before-reopen"
    )
    state = conversationReducer(state, {
      type: "sendAccepted",
      conversationId: "c1",
      requestId: "send-before-reopen",
    })

    state = conversationReducer(state, { type: "streamReopened", epoch: 1 })
    state = receive(state, 1, "c1", tool("recovered-tool", "running"))
    state = conversationReducer(state, {
      type: "detailRequested",
      conversationId: "c1",
      requestId: 1,
    })
    state = conversationReducer(state, {
      type: "detailSucceeded",
      conversationId: "c1",
      requestId: 1,
      detail: {
        conversationId: "c1",
        turns: [
          {
            id: "codex-recovered-user",
            role: "user",
            text: "重连前问题",
            status: "completed",
          },
        ],
      },
    })

    expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
      "重连前问题",
    ])
  })

  it("starts a new stream epoch by clearing stale turn UI and accepts recovered statuses", () => {
    let state = loadedState()
    state = receive(state, 80, "c2", { type: "turn_started", turnId: "lost" })
    state = receive(state, 81, "c2", tool("tool-lost", "running"))
    state = receive(state, 82, "c2", approval("approval-lost"))

    state = conversationReducer(state, { type: "streamReopened", epoch: 1 })

    expect(state.lastEventSeq).toBe(0)
    expect(state.streamEpoch).toBe(1)
    expect(state.recoveryGeneration).toBe(1)
    expect(state.summariesById.c2?.status).toBe("idle")
    expect(selectTools(state, "c2")).toEqual([])
    expect(selectApproval(state, "c2")).toBeNull()
    expect(isAnyConversationRunning(state)).toBe(false)

    state = receive(state, 1, "c2", {
      type: "turn_interrupted",
      turnId: "new-connection-terminal",
    })
    state = conversationReducer(state, {
      type: "recoveryListSucceeded",
      generation: 1,
      workspace: "/work/taskmux",
      conversations: [{ ...second, status: "running" }],
    })
    expect(state.summariesById.c2?.status).toBe("interrupted")
  })

  it("ignores a recovery list response from an older stream generation", () => {
    let state = loadedState()
    state = conversationReducer(state, { type: "streamReopened", epoch: 1 })
    state = conversationReducer(state, { type: "streamReopened", epoch: 2 })
    state = conversationReducer(state, {
      type: "recoveryListSucceeded",
      generation: 1,
      workspace: "/stale/workspace",
      conversations: [{ ...second, status: "running" }],
    })

    expect(state.recoveryGeneration).toBe(2)
    expect(state.order).toEqual(["c1", "c2"])
    expect(state.summariesById.c2?.status).toBe("idle")
    expect(state.recovering).toBe(true)
  })

  it("clears only the error scope owned by each successful request", () => {
    let state: ConversationState = {
      ...loadedState(),
      recoveryGeneration: 1,
      errors: {
        bootstrap: null,
        list: "列表错误",
        detail: { conversationId: "c1", message: "历史错误" },
        create: "新建错误",
        recovery: "恢复错误",
      },
    }
    state = conversationReducer(state, {
      type: "recoveryListSucceeded",
      generation: 1,
      workspace: "/recovered",
      conversations: [first, second],
    })

    expect(state.errors).toEqual({
      bootstrap: null,
      list: "列表错误",
      detail: { conversationId: "c1", message: "历史错误" },
      create: "新建错误",
      recovery: null,
    })

    state = conversationReducer(state, {
      type: "createSucceeded",
      conversation: { ...first, id: "new" },
    })
    expect(state.errors.create).toBeNull()
    expect(state.errors.detail).toEqual({
      conversationId: "c1",
      message: "历史错误",
    })
    expect(state.errors.list).toBe("列表错误")
  })

  it("ignores cancellation settlement from a retired stream request", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "cancelStarted",
      conversationId: "c1",
      requestId: "cancel-old",
    })
    state = conversationReducer(state, { type: "streamReopened", epoch: 1 })
    state = conversationReducer(state, {
      type: "cancelStarted",
      conversationId: "c1",
      requestId: "cancel-new",
    })
    state = conversationReducer(state, {
      type: "cancelFailed",
      conversationId: "c1",
      requestId: "cancel-old",
    })

    expect(state.liveByConversationId.c1?.cancelPending).toBe(true)
    expect(state.liveByConversationId.c1?.cancelError).toBeNull()
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
      type: "sendTransportRejected",
      conversationId: "c1",
      requestId: "send-1",
    })
    expect(selectDisplayedTurns(state, "c1")).toEqual([])
    expect(state.summariesById.c1?.status).toBe("idle")

    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-2",
      text: "已被服务接受",
    })
    state = receive(
      state,
      10,
      "c1",
      { type: "turn_started", turnId: "t2" },
      "send-2"
    )
    state = conversationReducer(state, {
      type: "sendTransportRejected",
      conversationId: "c1",
      requestId: "send-2",
    })
    expect(selectDisplayedTurns(state, "c1").at(-1)?.text).toBe(
      "已被服务接受"
    )
    expect(isAnyConversationRunning(state)).toBe(true)
  })

  it.each([
    { name: "tool status", event: tool("evidence-tool", "running") },
    { name: "approval request", event: approval("evidence-approval") },
  ])(
    "treats $name before turn_started as acceptance evidence on transport rejection",
    ({ event }) => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-evidence",
        text: "服务已接收",
      })
      state = receive(state, 1, "c1", event, "send-evidence")
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-evidence",
      })

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["服务已接收"])
      expect(state.liveByConversationId.c1?.httpSend).toBeNull()
      expect(state.liveByConversationId.c1?.sendError).toBe("发送失败，请重试。")
      expect(state.liveByConversationId.c1?.status).toBe("running")
      expect(state.summariesById.c1?.status).toBe("running")
      expect(isConversationActive(state, "c1")).toBe(true)
    }
  )

  it.each([
    {
      name: "old tool status",
      event: tool("old-evidence-tool", "running"),
      clientRequestId: "send-old",
    },
    {
      name: "unowned tool status",
      event: tool("unowned-evidence-tool", "running"),
      clientRequestId: undefined,
    },
    {
      name: "old approval request",
      event: approval("old-evidence-approval"),
      clientRequestId: "send-old",
    },
    {
      name: "unowned approval request",
      event: approval("unowned-evidence-approval"),
      clientRequestId: undefined,
    },
  ])(
    "does not let $name claim a newer pending send",
    ({ event, clientRequestId }) => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-new",
        text: "必须回滚的新请求",
      })
      state = receive(state, 1, "c1", event, clientRequestId)
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-new",
      })

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).not.toContain("必须回滚的新请求")
      expect(state.liveByConversationId.c1?.httpSend).toBeNull()
      expect(state.liveByConversationId.c1?.sendError).toBe("发送失败，请重试。")
      expect(state.liveByConversationId.c1?.status).toBe("running")
      expect(state.summariesById.c1?.status).toBe("running")
      expect(isConversationActive(state, "c1")).toBe(true)
    }
  )

  it("settles an HTTP success after SSE completed the turn first", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "draftChanged",
      conversationId: "c1",
      draft: "先终态后 HTTP",
    })
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-terminal-first",
      text: "先终态后 HTTP",
    })
    state = receive(
      state,
      1,
      "c1",
      { type: "turn_started", turnId: "terminal-first" },
      "send-terminal-first"
    )
    state = receive(
      state,
      2,
      "c1",
      { type: "text_delta", turnId: "terminal-first", text: "完成" },
      "send-terminal-first"
    )
    state = receive(
      state,
      3,
      "c1",
      { type: "turn_completed", turnId: "terminal-first" },
      "send-terminal-first"
    )

    expect(state.liveByConversationId.c1?.httpSend).toMatchObject({
      requestId: "send-terminal-first",
    })
    expect(state.liveByConversationId.c1?.sendAttempts).toContainEqual(
      expect.objectContaining({
        requestId: "send-terminal-first",
        state: "accepted",
        terminalObserved: true,
      })
    )
    expect(isConversationActive(state, "c1")).toBe(false)
    expect(isAnyConversationRunning(state)).toBe(true)

    state = conversationReducer(state, {
      type: "sendAccepted",
      conversationId: "c1",
      requestId: "send-terminal-first",
    })

    expect(state.liveByConversationId.c1?.httpSend).toBeNull()
    expect(state.liveByConversationId.c1?.draft).toBe("")
    expect(state.liveByConversationId.c1?.sendAttempts).toEqual([])
    expect(state.summariesById.c1?.status).toBe("idle")
  })

  it("settles an HTTP rejection after SSE terminal without rolling back accepted content", () => {
    let state = loadedState()
    state = conversationReducer(state, {
      type: "draftChanged",
      conversationId: "c1",
      draft: "已接受但响应失败",
    })
    state = conversationReducer(state, {
      type: "sendOptimistic",
      conversationId: "c1",
      requestId: "send-rejected-late",
      text: "已接受但响应失败",
    })
    state = receive(
      state,
      1,
      "c1",
      { type: "turn_started", turnId: "accepted-turn" },
      "send-rejected-late"
    )
    state = receive(
      state,
      2,
      "c1",
      { type: "turn_completed", turnId: "accepted-turn" },
      "send-rejected-late"
    )
    state = conversationReducer(state, {
      type: "sendTransportRejected",
      conversationId: "c1",
      requestId: "send-rejected-late",
    })

    expect(selectDisplayedTurns(state, "c1").map((turn) => turn.text)).toEqual([
      "已接受但响应失败",
    ])
    expect(state.liveByConversationId.c1?.httpSend).toBeNull()
    expect(state.liveByConversationId.c1?.draft).toBe("已接受但响应失败")
    expect(state.liveByConversationId.c1?.sendError).toBe("发送失败，请重试。")
    expect(state.summariesById.c1?.status).toBe("idle")
    expect(isAnyConversationRunning(state)).toBe(false)
  })

  describe("send attempt ownership", () => {
    it("treats HTTP 202 alone as acceptance that protects the optimistic user during reload", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-http-only",
        text: "HTTP 已接受的问题",
      })
      state = conversationReducer(state, {
        type: "sendAccepted",
        conversationId: "c1",
        requestId: "send-http-only",
      })
      state = conversationReducer(state, {
        type: "detailRequested",
        conversationId: "c1",
        requestId: 1,
      })
      state = conversationReducer(state, {
        type: "detailSucceeded",
        conversationId: "c1",
        requestId: 1,
        detail: { conversationId: "c1", turns: [] },
      })

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["HTTP 已接受的问题"])
      expect(state.liveByConversationId.c1?.sendAttempts).toContainEqual(
        expect.objectContaining({
          requestId: "send-http-only",
          state: "accepted",
        })
      )
      expect(isAnyConversationRunning(state)).toBe(true)
    })

    it.each([
      {
        order: "HTTP then SSE",
        evidence: "tool status",
        event: tool("accepted-tool", "running"),
      },
      {
        order: "HTTP then SSE",
        evidence: "approval request",
        event: approval("accepted-approval"),
      },
      {
        order: "SSE then HTTP",
        evidence: "tool status",
        event: tool("accepted-tool", "running"),
      },
      {
        order: "SSE then HTTP",
        evidence: "approval request",
        event: approval("accepted-approval"),
      },
    ])(
      "protects a 202-accepted optimistic user across $order $evidence and a running detail reload",
      ({ order, event }) => {
        let state = loadedState()
        state = conversationReducer(state, {
          type: "sendOptimistic",
          conversationId: "c1",
          requestId: "send-owned",
          text: "被接受的问题",
        })

        if (order === "HTTP then SSE") {
          state = conversationReducer(state, {
            type: "sendAccepted",
            conversationId: "c1",
            requestId: "send-owned",
          })
        }
        state = receive(state, 1, "c1", event, "send-owned")
        if (order === "SSE then HTTP") {
          state = conversationReducer(state, {
            type: "sendAccepted",
            conversationId: "c1",
            requestId: "send-owned",
          })
        }

        state = conversationReducer(state, {
          type: "detailRequested",
          conversationId: "c1",
          requestId: 1,
        })
        state = conversationReducer(state, {
          type: "detailSucceeded",
          conversationId: "c1",
          requestId: 1,
          detail: { conversationId: "c1", turns: [] },
        })

        expect(
          selectDisplayedTurns(state, "c1").map((turn) => turn.text)
        ).toEqual(["被接受的问题"])
        expect(state.summariesById.c1?.status).toBe("running")
        expect(isAnyConversationRunning(state)).toBe(true)
      }
    )

    it("restores the same optimistic user when matching SSE arrives after a transport rejection", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-uncertain",
        text: "响应未知的问题",
      })
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-uncertain",
      })

      expect(selectDisplayedTurns(state, "c1")).toEqual([])
      expect(isAnyConversationRunning(state)).toBe(false)

      state = receive(
        state,
        1,
        "c1",
        tool("late-tool", "running"),
        "send-uncertain"
      )

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["响应未知的问题"])
      expect(state.liveByConversationId.c1?.sendError).toBeNull()
      expect(isConversationActive(state, "c1")).toBe(true)
    })

    it("never lets an old late SSE envelope claim a newer send attempt", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-old",
        text: "旧问题",
      })
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-old",
      })
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-new",
        text: "新问题",
      })

      state = receive(
        state,
        1,
        "c1",
        approval("late-old-approval"),
        "send-old"
      )
      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["旧问题", "新问题"])
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-new",
      })

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["旧问题"])
      expect(state.liveByConversationId.c1?.sendError).toBe(
        "发送失败，请重试。"
      )
      expect(isConversationActive(state, "c1")).toBe(true)
    })

    it("bounds rejected transport tombstones while retaining recent late-correlation evidence", () => {
      let state = loadedState()
      for (let index = 1; index <= 9; index += 1) {
        state = conversationReducer(state, {
          type: "sendOptimistic",
          conversationId: "c1",
          requestId: `send-${index}`,
          text: `问题 ${index}`,
        })
        state = conversationReducer(state, {
          type: "sendTransportRejected",
          conversationId: "c1",
          requestId: `send-${index}`,
        })
      }

      state = receive(
        state,
        1,
        "c1",
        tool("too-old", "running"),
        "send-1"
      )
      expect(selectDisplayedTurns(state, "c1")).toEqual([])

      state = receive(
        state,
        2,
        "c1",
        tool("recent", "running"),
        "send-9"
      )
      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["问题 9"])
    })

    it("treats a 409 as definitive rejection without retaining a visible user or send lock", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-conflict",
        text: "冲突问题",
      })
      state = conversationReducer(state, {
        type: "sendConflict",
        conversationId: "c1",
        requestId: "send-conflict",
      })

      expect(selectDisplayedTurns(state, "c1")).toEqual([])
      expect(state.summariesById.c1?.status).toBe("idle")
      expect(isAnyConversationRunning(state)).toBe(false)

      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-after-conflict",
        text: "冲突后的新问题",
      })
      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["冲突后的新问题"])
    })

    it("retires a terminal attempt only after successful cross-ID history reconciliation", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-terminal",
        text: "终态问题",
      })
      state = conversationReducer(state, {
        type: "sendAccepted",
        conversationId: "c1",
        requestId: "send-terminal",
      })
      state = receive(
        state,
        1,
        "c1",
        { type: "text_delta", turnId: "provider-turn", text: "终态回答" },
        "send-terminal"
      )
      state = receive(
        state,
        2,
        "c1",
        { type: "turn_completed", turnId: "provider-turn" },
        "send-terminal"
      )
      state = conversationReducer(state, {
        type: "detailRequested",
        conversationId: "c1",
        requestId: 1,
      })
      state = conversationReducer(state, {
        type: "detailFailed",
        conversationId: "c1",
        requestId: 1,
        message: "历史同步失败",
      })

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["终态问题", "终态回答"])

      state = conversationReducer(state, {
        type: "detailRequested",
        conversationId: "c1",
        requestId: 2,
      })
      state = conversationReducer(state, {
        type: "detailSucceeded",
        conversationId: "c1",
        requestId: 2,
        detail: {
          conversationId: "c1",
          turns: [
            {
              id: "codex-user-item",
              role: "user",
              text: "终态问题",
              status: "completed",
            },
            {
              id: "codex-assistant-item",
              role: "assistant",
              text: "终态回答",
              status: "completed",
            },
          ],
        },
      })
      state = receive(
        state,
        3,
        "c1",
        tool("late-after-retirement", "running"),
        "send-terminal"
      )

      expect(selectDisplayedTurns(state, "c1")).toEqual([
        {
          id: "codex-user-item",
          role: "user",
          text: "终态问题",
          status: "completed",
        },
        {
          id: "codex-assistant-item",
          role: "assistant",
          text: "终态回答",
          status: "completed",
        },
      ])
    })

    it("drops pre-reconnect attempts and ignores their stale HTTP settlement and correlation", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-before-reopen",
        text: "重连前问题",
      })
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-before-reopen",
      })
      state = conversationReducer(state, { type: "streamReopened", epoch: 1 })
      state = conversationReducer(state, {
        type: "recoveryListSucceeded",
        generation: 1,
        workspace: "/work/taskmux",
        conversations: [first, second],
      })
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-after-reopen",
        text: "重连后问题",
      })

      state = conversationReducer(state, {
        type: "sendAccepted",
        conversationId: "c1",
        requestId: "send-before-reopen",
      })
      state = receive(
        state,
        1,
        "c1",
        {
          type: "error",
          code: "stale",
          message: "stale",
          terminal: false,
        },
        "send-before-reopen"
      )

      expect(
        selectDisplayedTurns(state, "c1").map((turn) => turn.text)
      ).toEqual(["重连后问题"])
      expect(isAnyConversationRunning(state)).toBe(true)
    })

    it("does not let an old terminal event unlock a newer accepted send", () => {
      let state = loadedState()
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-old-terminal",
        text: "旧问题",
      })
      state = conversationReducer(state, {
        type: "sendTransportRejected",
        conversationId: "c1",
        requestId: "send-old-terminal",
      })
      state = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-new-accepted",
        text: "新问题",
      })
      state = conversationReducer(state, {
        type: "sendAccepted",
        conversationId: "c1",
        requestId: "send-new-accepted",
      })

      state = receive(
        state,
        1,
        "c1",
        { type: "turn_started", turnId: "old-turn" },
        "send-old-terminal"
      )
      state = receive(
        state,
        2,
        "c1",
        { type: "turn_completed", turnId: "old-turn" },
        "send-old-terminal"
      )

      expect(state.summariesById.c1?.status).toBe("running")
      expect(isAnyConversationRunning(state)).toBe(true)
      expect(state.liveByConversationId.c1?.sendAttempts).toEqual([
        expect.objectContaining({
          requestId: "send-new-accepted",
          state: "accepted",
          terminalObserved: false,
        }),
      ])

      const afterThirdSend = conversationReducer(state, {
        type: "sendOptimistic",
        conversationId: "c1",
        requestId: "send-third",
        text: "不应被接受",
      })
      expect(afterThirdSend).toBe(state)
    })

    it("retires terminal attempt ownership even when history reconciliation fails", () => {
      let state = loadedState()
      let seq = 0
      for (let index = 1; index <= 20; index += 1) {
        const requestId = `send-terminal-${index}`
        const turnId = `turn-terminal-${index}`
        state = conversationReducer(state, {
          type: "sendOptimistic",
          conversationId: "c1",
          requestId,
          text: `问题 ${index}`,
        })
        state = conversationReducer(state, {
          type: "sendAccepted",
          conversationId: "c1",
          requestId,
        })
        state = receive(
          state,
          ++seq,
          "c1",
          { type: "turn_started", turnId },
          requestId
        )
        state = receive(
          state,
          ++seq,
          "c1",
          { type: "turn_completed", turnId },
          requestId
        )
        state = conversationReducer(state, {
          type: "detailRequested",
          conversationId: "c1",
          requestId: index,
        })
        state = conversationReducer(state, {
          type: "detailFailed",
          conversationId: "c1",
          requestId: index,
          message: "历史暂不可用",
        })
      }

      expect(state.liveByConversationId.c1?.sendAttempts).toEqual([])
      expect(selectDisplayedTurns(state, "c1")).toHaveLength(20)
      expect(isAnyConversationRunning(state)).toBe(false)
    })

    it("releases completed live text buffers after moving them into transient history", () => {
      let state = loadedState()
      let seq = 0
      for (let index = 1; index <= 20; index += 1) {
        const turnId = `buffered-turn-${index}`
        state = receive(state, ++seq, "c1", {
          type: "turn_started",
          turnId,
        })
        state = receive(state, ++seq, "c1", {
          type: "text_delta",
          turnId,
          text: "x".repeat(100_000),
        })
        state = receive(state, ++seq, "c1", {
          type: "turn_completed",
          turnId,
        })
        state = conversationReducer(state, {
          type: "detailRequested",
          conversationId: "c1",
          requestId: index,
        })
        state = conversationReducer(state, {
          type: "detailSucceeded",
          conversationId: "c1",
          requestId: index,
          detail: {
            conversationId: "c1",
            turns: [
              {
                id: `history-${index}`,
                role: "assistant",
                text: "done",
                status: "completed",
              },
            ],
          },
        })
      }

      expect(state.liveByConversationId.c1?.textByTurnId).toEqual({})
    })
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
      for (const [seq, clientRequestId] of [
        [2, 42],
        [3, " \n "],
        [5, "😀".repeat(129)],
      ] as const) {
        source.message(
          JSON.stringify({
            conversationId: "c1",
            clientRequestId,
            seq,
            payload: { type: "turn_started", turnId: "invalid-metadata" },
          })
        )
      }
      source.message(
        JSON.stringify({
          conversationId: "c1",
          clientRequestId: "send-safe-1",
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
          clientRequestId: "send-safe-1",
          seq: 4,
          payload: { type: "text_delta", turnId: "t1", text: "hello" },
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain("operationId")
    expect(JSON.stringify(events)).not.toContain("rawProvider")
  })

  it("resets the accepted seq baseline only after an error-driven reopen", () => {
    const dispatch = vi.fn<(action: ConversationAction) => void>()
    render(<StreamProbe dispatch={dispatch} />)
    const source = FakeEventSource.instances[0]!

    act(() => {
      source.open()
      source.message(
        JSON.stringify({
          conversationId: "c1",
          seq: 80,
          payload: { type: "turn_started", turnId: "old" },
        })
      )
      source.fail()
      source.open()
      source.message(
        JSON.stringify({
          conversationId: "c1",
          seq: 1,
          payload: { type: "turn_started", turnId: "new" },
        })
      )
    })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(
      dispatch.mock.calls.map(([action]) => action).filter(
        (action) =>
          action.type === "streamReopened" || action.type === "eventReceived"
      )
    ).toEqual([
      {
        type: "eventReceived",
        envelope: {
          conversationId: "c1",
          seq: 80,
          payload: { type: "turn_started", turnId: "old" },
        },
      },
      { type: "streamReopened", epoch: 1 },
      {
        type: "eventReceived",
        envelope: {
          conversationId: "c1",
          seq: 1,
          payload: { type: "turn_started", turnId: "new" },
        },
      },
    ])
  })

  it("starts a recovery epoch when the first successful open follows an error", () => {
    const dispatch = vi.fn<(action: ConversationAction) => void>()
    render(<StreamProbe dispatch={dispatch} />)
    const source = FakeEventSource.instances[0]!

    act(() => {
      source.fail()
      source.open()
    })

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(
      dispatch.mock.calls
        .map(([action]) => action)
        .filter((action) => action.type === "streamReopened")
    ).toEqual([{ type: "streamReopened", epoch: 1 }])
    expect(screen.getByRole("status")).toHaveTextContent("connected")
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
  payload: ConversationEvent,
  clientRequestId?: string
): ConversationState {
  const envelope: ConversationEventEnvelope = {
    conversationId,
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
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
