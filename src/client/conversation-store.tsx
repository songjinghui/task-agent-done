import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react"
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConversationDetail,
  ConversationEvent,
  ConversationEventEnvelope,
  ConversationStatus,
  ConversationSummary,
  MessageTurn,
  ToolStatus,
} from "../shared/contracts.js"
import { TaskMuxApiError, type TaskMuxApi } from "./api.js"
import { useEventStream } from "./use-event-stream.js"

export type ConversationLoadingState = {
  list: boolean
  create: boolean
  detail: boolean
}

export type ConversationErrors = {
  bootstrap: string | null
  list: string | null
  detail: { conversationId: string; message: string } | null
  create: string | null
  recovery: string | null
}

export type ConversationState = {
  workspace: string | null
  summariesById: Record<string, ConversationSummary>
  order: string[]
  locallyCreatedIds: string[]
  selectedId: string | null
  detailsById: Record<string, ConversationDetail>
  loading: ConversationLoadingState
  errors: ConversationErrors
  detailRequest: {
    conversationId: string
    requestId: number
    transientTurnIds: string[]
  } | null
  detailLoadGeneration: number
  terminalDetailSyncKeys: Record<string, true>
  lastEventSeq: number
  streamStatus: "connecting" | "connected" | "disconnected"
  streamEpoch: number
  recoveryGeneration: number
  recovering: boolean
  liveByConversationId: Record<string, LiveConversationState>
}

export type LiveConversationState = {
  status: ConversationStatus | null
  activeTurnId: string | null
  textByTurnId: Record<string, string>
  toolsById: Record<string, ToolStatus>
  toolOrder: string[]
  approval: ApprovalRequest | null
  approvalError: string | null
  transientTurns: MessageTurn[]
  draft: string
  sendError: string | null
  cancelPending: boolean
  cancelRequestId: string | null
  cancelError: string | null
  acceptedOptimisticTurnId: string | null
  pendingSend: {
    requestId: string
    optimisticTurnId: string
    submittedText: string
    previousStatus: ConversationSummary["status"]
    acceptedByEvent: boolean
    turnActivityObserved: boolean
  } | null
  error: string | null
}

export const initialConversationState: ConversationState = {
  workspace: null,
  summariesById: {},
  order: [],
  locallyCreatedIds: [],
  selectedId: null,
  detailsById: {},
  loading: { list: true, create: false, detail: false },
  errors: {
    bootstrap: null,
    list: null,
    detail: null,
    create: null,
    recovery: null,
  },
  detailRequest: null,
  detailLoadGeneration: 0,
  terminalDetailSyncKeys: {},
  lastEventSeq: 0,
  streamStatus: "connecting",
  streamEpoch: 0,
  recoveryGeneration: 0,
  recovering: false,
  liveByConversationId: {},
}

export type ConversationAction =
  | {
      type: "listSucceeded"
      workspace: string
      conversations: ConversationSummary[]
      generation?: number
    }
  | {
      type: "listFailed"
      message: string
      scope: "bootstrap" | "list" | "recovery"
      generation?: number
    }
  | {
      type: "recoveryListSucceeded"
      generation: number
      workspace: string
      conversations: ConversationSummary[]
    }
  | { type: "streamReopened"; epoch: number }
  | { type: "createStarted" }
  | { type: "createSucceeded"; conversation: ConversationSummary }
  | { type: "createFailed"; message: string }
  | { type: "selected"; conversationId: string }
  | { type: "retrySelectedDetail" }
  | { type: "detailRequested"; conversationId: string; requestId: number }
  | {
      type: "detailSucceeded"
      conversationId: string
      requestId: number
      detail: ConversationDetail
    }
  | {
      type: "detailFailed"
      conversationId: string
      requestId: number
      message: string
    }
  | { type: "eventReceived"; envelope: ConversationEventEnvelope }
  | {
      type: "streamStatusChanged"
      status: ConversationState["streamStatus"]
    }
  | {
      type: "sendOptimistic"
      conversationId: string
      requestId: string
      text: string
    }
  | { type: "draftChanged"; conversationId: string; draft: string }
  | { type: "sendSucceeded"; conversationId: string; requestId: string }
  | {
      type: "sendRejected"
      conversationId: string
      requestId: string
      message: string
    }
  | {
      type: "approvalResolved"
      conversationId: string
      requestId: string
    }
  | {
      type: "approvalFailed"
      conversationId: string
      requestId: string
      expired: boolean
    }
  | { type: "cancelStarted"; conversationId: string; requestId: string }
  | { type: "cancelSettled"; conversationId: string; requestId: string }
  | { type: "cancelFailed"; conversationId: string; requestId: string }

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction
): ConversationState {
  switch (action.type) {
    case "listSucceeded": {
      if (
        action.generation !== undefined &&
        action.generation !== state.recoveryGeneration
      ) {
        return state
      }
      const summariesById = mergeLiveStatuses(state, action.conversations)
      const order = action.conversations.map((conversation) => conversation.id)
      return {
        ...state,
        workspace: action.workspace,
        summariesById,
        order,
        selectedId: order[0] ?? null,
        loading: { ...state.loading, list: false },
        errors: { ...state.errors, bootstrap: null, list: null },
      }
    }
    case "listFailed":
      if (
        action.generation !== undefined &&
        action.generation !== state.recoveryGeneration
      ) {
        return state
      }
      return {
        ...state,
        loading: { ...state.loading, list: false },
        recovering: false,
        errors: { ...state.errors, [action.scope]: action.message },
      }
    case "recoveryListSucceeded": {
      if (action.generation !== state.recoveryGeneration) return state
      const { summariesById, order } = mergeRecoverySummaries(
        state,
        action.conversations
      )
      const selectedId =
        state.selectedId && summariesById[state.selectedId]
          ? state.selectedId
          : (order[0] ?? null)
      return {
        ...state,
        workspace: action.workspace,
        summariesById,
        order,
        locallyCreatedIds: state.locallyCreatedIds.filter(
          (id) =>
            !action.conversations.some(
              (conversation) => conversation.id === id
            )
        ),
        selectedId,
        loading: { ...state.loading, list: false },
        recovering: false,
        errors: { ...state.errors, recovery: null },
      }
    }
    case "streamReopened": {
      if (action.epoch <= state.streamEpoch) return state
      const summariesById = Object.fromEntries(
        Object.values(state.summariesById).map((summary) => [
          summary.id,
          summary.status === "running"
            ? { ...summary, status: "idle" as const }
            : summary,
        ])
      )
      const liveByConversationId = Object.fromEntries(
        Object.entries(state.liveByConversationId).map(([conversationId, live]) => [
          conversationId,
          {
            ...live,
            status: null,
            activeTurnId: null,
            textByTurnId: {},
            toolsById: {},
            toolOrder: [],
            approval: null,
            approvalError: null,
            acceptedOptimisticTurnId: null,
            pendingSend: null,
            cancelPending: false,
            cancelRequestId: null,
            cancelError: null,
          },
        ])
      )
      return {
        ...state,
        summariesById,
        liveByConversationId,
        lastEventSeq: 0,
        streamEpoch: action.epoch,
        recoveryGeneration: state.recoveryGeneration + 1,
        recovering: true,
        detailRequest: null,
        detailLoadGeneration: state.detailLoadGeneration + 1,
        terminalDetailSyncKeys: {},
        errors: {
          ...state.errors,
          bootstrap: null,
          list: null,
          recovery: null,
        },
      }
    }
    case "createStarted":
      return {
        ...state,
        loading: { ...state.loading, create: true },
        errors: { ...state.errors, create: null },
      }
    case "createSucceeded":
      return {
        ...state,
        summariesById: {
          ...state.summariesById,
          [action.conversation.id]: action.conversation,
        },
        order: [
          action.conversation.id,
          ...state.order.filter((id) => id !== action.conversation.id),
        ],
        locallyCreatedIds: [
          action.conversation.id,
          ...state.locallyCreatedIds.filter(
            (id) => id !== action.conversation.id
          ),
        ],
        selectedId: action.conversation.id,
        loading: { ...state.loading, create: false },
        errors: { ...state.errors, create: null },
      }
    case "createFailed":
      return {
        ...state,
        loading: { ...state.loading, create: false },
        errors: { ...state.errors, create: action.message },
      }
    case "selected":
      if (!state.summariesById[action.conversationId]) return state
      if (state.selectedId === action.conversationId) return state
      return {
        ...state,
        selectedId: action.conversationId,
      }
    case "retrySelectedDetail":
      if (
        !state.selectedId ||
        state.errors.detail?.conversationId !== state.selectedId ||
        state.loading.detail
      ) {
        return state
      }
      return {
        ...state,
        loading: { ...state.loading, detail: true },
        errors: { ...state.errors, detail: null },
        detailLoadGeneration: state.detailLoadGeneration + 1,
      }
    case "detailRequested":
      if (state.selectedId !== action.conversationId) return state
      return {
        ...state,
        loading: { ...state.loading, detail: true },
        detailRequest: {
          conversationId: action.conversationId,
          requestId: action.requestId,
          transientTurnIds: retirableTransientIds(
            state.liveByConversationId[action.conversationId]
          ),
        },
      }
    case "detailSucceeded":
      if (!isCurrentDetailRequest(state, action)) return state
      return retireTransientTurns({
        ...state,
        detailsById: {
          ...state.detailsById,
          [action.conversationId]: action.detail,
        },
        loading: { ...state.loading, detail: false },
        detailRequest: null,
        errors: { ...state.errors, detail: null },
      }, action.conversationId, state.detailRequest!.transientTurnIds)
    case "detailFailed":
      if (!isCurrentDetailRequest(state, action)) return state
      return {
        ...state,
        loading: { ...state.loading, detail: false },
        detailRequest: null,
        errors: {
          ...state.errors,
          detail: {
            conversationId: action.conversationId,
            message: action.message,
          },
        },
      }
    case "streamStatusChanged":
      return state.streamStatus === action.status
        ? state
        : { ...state, streamStatus: action.status }
    case "eventReceived":
      return reduceEvent(state, action.envelope)
    case "draftChanged": {
      const live = liveFor(state, action.conversationId)
      return withLive(state, action.conversationId, {
        ...live,
        draft: action.draft,
        sendError: null,
      })
    }
    case "sendOptimistic": {
      const live = liveFor(state, action.conversationId)
      if (live.pendingSend || live.activeTurnId) return state
      const optimisticTurnId = `optimistic:${action.requestId}`
      const previousStatus =
        state.summariesById[action.conversationId]?.status ?? "idle"
      return withLive(
        withSummaryStatus(state, action.conversationId, "running"),
        action.conversationId,
        {
          ...live,
          status: "running",
          transientTurns: [
            ...live.transientTurns,
            {
              id: optimisticTurnId,
              role: "user",
              text: action.text,
              status: "completed",
            },
          ],
          pendingSend: {
            requestId: action.requestId,
            optimisticTurnId,
            submittedText: action.text,
            previousStatus,
            acceptedByEvent: false,
            turnActivityObserved: false,
          },
          acceptedOptimisticTurnId: null,
          sendError: null,
          error: null,
        }
      )
    }
    case "sendSucceeded": {
      const live = state.liveByConversationId[action.conversationId]
      if (live?.pendingSend?.requestId !== action.requestId) return state
      return withLive(state, action.conversationId, {
        ...live,
        draft:
          live.draft === live.pendingSend.submittedText ? "" : live.draft,
        pendingSend: null,
        sendError: null,
      })
    }
    case "sendRejected": {
      const live = state.liveByConversationId[action.conversationId]
      const pending = live?.pendingSend
      if (!live || !pending || pending.requestId !== action.requestId) return state
      const accepted = pending.acceptedByEvent
      const keepLiveState = accepted || pending.turnActivityObserved
      const nextLive: LiveConversationState = {
        ...live,
        status: keepLiveState ? live.status : pending.previousStatus,
        transientTurns: accepted
          ? live.transientTurns
          : live.transientTurns.filter(
              (turn) => turn.id !== pending.optimisticTurnId
            ),
        pendingSend: null,
        sendError: "发送失败，请重试。",
        error: live.error,
      }
      const next = withLive(state, action.conversationId, nextLive)
      return keepLiveState
        ? next
        : withSummaryStatus(next, action.conversationId, pending.previousStatus)
    }
    case "approvalResolved": {
      const live = state.liveByConversationId[action.conversationId]
      if (!live || live.approval?.id !== action.requestId) return state
      return withLive(state, action.conversationId, {
        ...live,
        approval: null,
        approvalError: null,
      })
    }
    case "approvalFailed": {
      const live = state.liveByConversationId[action.conversationId]
      if (!live || live.approval?.id !== action.requestId) return state
      return withLive(state, action.conversationId, {
        ...live,
        approval: action.expired ? null : live.approval,
        approvalError: action.expired
          ? "审批请求已失效。"
          : "无法处理审批请求。",
      })
    }
    case "cancelStarted": {
      const live = liveFor(state, action.conversationId)
      return withLive(state, action.conversationId, {
        ...live,
        cancelPending: true,
        cancelRequestId: action.requestId,
        cancelError: null,
      })
    }
    case "cancelSettled": {
      const live = state.liveByConversationId[action.conversationId]
      return live?.cancelRequestId === action.requestId
        ? withLive(state, action.conversationId, {
            ...live,
            cancelPending: false,
            cancelRequestId: null,
          })
        : state
    }
    case "cancelFailed": {
      const live = state.liveByConversationId[action.conversationId]
      return live?.cancelRequestId === action.requestId
        ? withLive(state, action.conversationId, {
            ...live,
            cancelPending: false,
            cancelRequestId: null,
            cancelError: "取消失败，请重试。",
          })
        : state
    }
  }
}

function reduceEvent(
  state: ConversationState,
  envelope: ConversationEventEnvelope
): ConversationState {
  if (envelope.seq <= state.lastEventSeq) return state
  const stateWithSeq = { ...state, lastEventSeq: envelope.seq }
  const conversationId = envelope.conversationId
  const live = observeEventForPendingSend(
    liveFor(stateWithSeq, conversationId),
    envelope
  )
  const payload = envelope.payload

  switch (payload.type) {
    case "turn_started": {
      const nextLive: LiveConversationState = {
        ...live,
        status: "running",
        activeTurnId: payload.turnId,
        error: null,
      }
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "running"),
        conversationId,
        nextLive
      )
    }
    case "text_delta": {
      if (live.activeTurnId && live.activeTurnId !== payload.turnId) {
        return stateWithSeq
      }
      const nextLive: LiveConversationState = {
        ...live,
        status: "running",
        activeTurnId: payload.turnId,
        textByTurnId: {
          ...live.textByTurnId,
          [payload.turnId]:
            (live.textByTurnId[payload.turnId] ?? "") + payload.text,
        },
      }
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "running"),
        conversationId,
        nextLive
      )
    }
    case "tool_status": {
      const known = Boolean(live.toolsById[payload.tool.id])
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "running"),
        conversationId,
        {
          ...live,
          status: "running",
          toolsById: { ...live.toolsById, [payload.tool.id]: payload.tool },
          toolOrder: known
            ? live.toolOrder
            : [...live.toolOrder, payload.tool.id],
        }
      )
    }
    case "approval_requested":
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "running"),
        conversationId,
        {
          ...live,
          status: "running",
          approval: payload.request,
          approvalError: null,
        }
      )
    case "turn_completed": {
      if (live.activeTurnId && live.activeTurnId !== payload.turnId) {
        return stateWithSeq
      }
      const text = live.textByTurnId[payload.turnId] ?? ""
      const alreadyRecorded = live.transientTurns.some(
        (turn) => turn.id === payload.turnId
      )
      const transientTurns =
        text || alreadyRecorded
          ? alreadyRecorded
            ? live.transientTurns
            : [
                ...live.transientTurns,
                {
                  id: payload.turnId,
                  role: "assistant" as const,
                  text,
                  status: "completed" as const,
                },
              ]
          : live.transientTurns
      return syncSelectedDetailAfterTerminal(
        withLive(
          withSummaryStatus(stateWithSeq, conversationId, "idle"),
          conversationId,
          terminalLive(live, { status: "idle", transientTurns })
        ),
        conversationId,
        terminalDetailSyncKey(stateWithSeq, envelope)
      )
    }
    case "turn_interrupted":
      if (live.activeTurnId && live.activeTurnId !== payload.turnId) {
        return stateWithSeq
      }
      return syncSelectedDetailAfterTerminal(
        withLive(
          withSummaryStatus(stateWithSeq, conversationId, "interrupted"),
          conversationId,
          terminalLive(live, { status: "interrupted" })
        ),
        conversationId,
        terminalDetailSyncKey(stateWithSeq, envelope)
      )
    case "error": {
      if (!payload.terminal) {
        return withLive(stateWithSeq, conversationId, {
          ...live,
          approval:
            payload.code === "approval_expired" ? null : live.approval,
          error: payload.message,
        })
      }
      if (
        payload.scope === "turn" &&
        live.activeTurnId &&
        live.activeTurnId !== payload.turnId
      ) {
        return stateWithSeq
      }
      return syncSelectedDetailAfterTerminal(
        withLive(
          withSummaryStatus(stateWithSeq, conversationId, "failed"),
          conversationId,
          terminalLive(live, { status: "failed", error: payload.message })
        ),
        conversationId,
        terminalDetailSyncKey(stateWithSeq, envelope)
      )
    }
  }
}

function observeEventForPendingSend(
  live: LiveConversationState,
  envelope: ConversationEventEnvelope
): LiveConversationState {
  if (!live.pendingSend) return live
  const acceptedByThisEvent =
    envelope.clientRequestId === live.pendingSend.requestId
  return {
    ...live,
    acceptedOptimisticTurnId: acceptedByThisEvent
      ? live.pendingSend.optimisticTurnId
      : live.acceptedOptimisticTurnId,
    pendingSend: {
      ...live.pendingSend,
      acceptedByEvent:
        live.pendingSend.acceptedByEvent ||
        acceptedByThisEvent,
      turnActivityObserved:
        live.pendingSend.turnActivityObserved ||
        isTurnActivity(envelope.payload),
    },
  }
}

function isTurnActivity(payload: ConversationEvent): boolean {
  return payload.type !== "error" || payload.terminal
}

function syncSelectedDetailAfterTerminal(
  state: ConversationState,
  conversationId: string,
  terminalKey: string
): ConversationState {
  if (
    state.selectedId !== conversationId ||
    state.terminalDetailSyncKeys[terminalKey]
  ) {
    return state
  }
  return {
    ...state,
    detailRequest: null,
    detailLoadGeneration: state.detailLoadGeneration + 1,
    loading: { ...state.loading, detail: true },
    terminalDetailSyncKeys: {
      ...state.terminalDetailSyncKeys,
      [terminalKey]: true,
    },
  }
}

function terminalDetailSyncKey(
  state: ConversationState,
  envelope: ConversationEventEnvelope
): string {
  const payload = envelope.payload
  const identity =
    payload.type === "turn_completed" || payload.type === "turn_interrupted"
      ? `turn:${payload.turnId}`
      : payload.type === "error" &&
          payload.terminal &&
          payload.scope === "turn"
        ? `turn:${payload.turnId}`
        : `session:${envelope.seq}`
  return `${state.streamEpoch}:${envelope.conversationId}:${identity}`
}

function terminalLive(
  live: LiveConversationState,
  overrides: Partial<LiveConversationState> = {}
): LiveConversationState {
  return {
    ...live,
    activeTurnId: null,
    toolsById: {},
    toolOrder: [],
    approval: null,
    approvalError: null,
    pendingSend: live.pendingSend,
    cancelPending: false,
    cancelRequestId: null,
    ...overrides,
  }
}

function emptyLive(): LiveConversationState {
  return {
    status: null,
    activeTurnId: null,
    textByTurnId: {},
    toolsById: {},
    toolOrder: [],
    approval: null,
    approvalError: null,
    transientTurns: [],
    draft: "",
    sendError: null,
    cancelPending: false,
    cancelRequestId: null,
    cancelError: null,
    acceptedOptimisticTurnId: null,
    pendingSend: null,
    error: null,
  }
}

function mergeLiveStatuses(
  state: ConversationState,
  conversations: ConversationSummary[]
): Record<string, ConversationSummary> {
  return Object.fromEntries(
    conversations.map((conversation) => {
      const liveStatus = state.liveByConversationId[conversation.id]?.status
      return [
        conversation.id,
        liveStatus ? { ...conversation, status: liveStatus } : conversation,
      ]
    })
  )
}

function mergeRecoverySummaries(
  state: ConversationState,
  conversations: ConversationSummary[]
): Pick<ConversationState, "summariesById" | "order"> {
  const recovered = mergeLiveStatuses(state, conversations)
  const locallyCreated = new Set(state.locallyCreatedIds)
  const retainedIds = state.order.filter(
    (id) => !recovered[id] || locallyCreated.has(id)
  )
  const summariesById = {
    ...recovered,
    ...Object.fromEntries(
      retainedIds.flatMap((id) => {
        const summary = state.summariesById[id]
        return summary ? [[id, summary]] : []
      })
    ),
  }
  return {
    summariesById,
    order: [
      ...retainedIds,
      ...conversations
        .map((conversation) => conversation.id)
        .filter((id) => !retainedIds.includes(id)),
    ],
  }
}

function retireTransientTurns(
  state: ConversationState,
  conversationId: string,
  retiredIds: string[]
): ConversationState {
  const live = state.liveByConversationId[conversationId]
  if (!live || retiredIds.length === 0) return state
  const retired = new Set(retiredIds)
  return withLive(state, conversationId, {
    ...live,
    transientTurns: live.transientTurns.filter((turn) => !retired.has(turn.id)),
    acceptedOptimisticTurnId:
      live.acceptedOptimisticTurnId && retired.has(live.acceptedOptimisticTurnId)
        ? null
        : live.acceptedOptimisticTurnId,
  })
}

function retirableTransientIds(
  live: LiveConversationState | undefined
): string[] {
  if (!live) return []
  const protectedId =
    live.pendingSend && !live.pendingSend.acceptedByEvent
      ? live.pendingSend.optimisticTurnId
      : live.status === "running"
        ? (live.acceptedOptimisticTurnId ?? undefined)
        : undefined
  return live.transientTurns
    .filter((turn) => turn.id !== protectedId)
    .map((turn) => turn.id)
}

function liveFor(
  state: ConversationState,
  conversationId: string
): LiveConversationState {
  return state.liveByConversationId[conversationId] ?? emptyLive()
}

function withLive(
  state: ConversationState,
  conversationId: string,
  live: LiveConversationState
): ConversationState {
  return {
    ...state,
    liveByConversationId: {
      ...state.liveByConversationId,
      [conversationId]: live,
    },
  }
}

function withSummaryStatus(
  state: ConversationState,
  conversationId: string,
  status: ConversationSummary["status"]
): ConversationState {
  const summary = state.summariesById[conversationId]
  if (!summary || summary.status === status) return state
  return {
    ...state,
    summariesById: {
      ...state.summariesById,
      [conversationId]: { ...summary, status },
    },
  }
}

export function selectLiveText(
  state: ConversationState,
  conversationId: string,
  turnId: string
): string {
  const live = state.liveByConversationId[conversationId]
  return live?.activeTurnId === turnId
    ? (live.textByTurnId[turnId] ?? "")
    : ""
}

export function selectTools(
  state: ConversationState,
  conversationId: string
): ToolStatus[] {
  const live = state.liveByConversationId[conversationId]
  return live
    ? live.toolOrder.flatMap((id) => {
        const tool = live.toolsById[id]
        return tool ? [tool] : []
      })
    : []
}

export function selectApproval(
  state: ConversationState,
  conversationId: string
): ApprovalRequest | null {
  return state.liveByConversationId[conversationId]?.approval ?? null
}

export function selectDisplayedTurns(
  state: ConversationState,
  conversationId: string
): MessageTurn[] {
  const history =
    state.detailsById[conversationId]?.turns.filter(
      (turn) => turn.status === "completed"
    ) ?? []
  const historyIds = new Set(history.map((turn) => turn.id))
  const transient =
    state.liveByConversationId[conversationId]?.transientTurns.filter(
      (turn) => !historyIds.has(turn.id)
    ) ?? []
  return [...history, ...transient]
}

export function isConversationActive(
  state: ConversationState,
  conversationId: string
): boolean {
  const live = state.liveByConversationId[conversationId]
  return Boolean(
    live?.activeTurnId ||
      state.summariesById[conversationId]?.status === "running"
  )
}

export function isAnyConversationRunning(state: ConversationState): boolean {
  return state.order.some((id) => isConversationActive(state, id)) ||
    Object.entries(state.liveByConversationId).some(
      ([id, live]) =>
        Boolean(live.pendingSend) ||
        (!state.summariesById[id] && isConversationActive(state, id))
    )
}

type DetailRequestAction = {
  conversationId: string
  requestId: number
}

function isCurrentDetailRequest(
  state: ConversationState,
  action: DetailRequestAction
): boolean {
  return (
    state.selectedId === action.conversationId &&
    state.detailRequest?.conversationId === action.conversationId &&
    state.detailRequest.requestId === action.requestId
  )
}

export type ConversationStore = {
  state: ConversationState
  conversations: ConversationSummary[]
  selectedConversation: ConversationSummary | null
  selectedDetail: ConversationDetail | null
  createConversation(): Promise<void>
  select(conversationId: string): void
  retrySelectedDetail(): void
  updateDraft(draft: string): void
  sendMessage(text: string): Promise<void>
  cancelSelected(): Promise<void>
  respondToApproval(
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void>
}

const ConversationContext = createContext<ConversationStore | null>(null)

export function ConversationProvider({
  api,
  children,
}: {
  api: TaskMuxApi
  children: ReactNode
}): ReactNode {
  const [state, dispatch] = useReducer(
    conversationReducer,
    initialConversationState
  )
  const mounted = useRef(false)
  const createInFlight = useRef(false)
  const sendInFlight = useRef<object | null>(null)
  const cancelInFlight = useRef(new Map<string, string>())
  const approvalInFlight = useRef(new Set<string>())
  const sendRequestId = useRef(0)
  const cancelRequestId = useRef(0)
  const detailRequestId = useRef(0)
  useEventStream(dispatch)

  useEffect(() => {
    sendInFlight.current = null
    cancelInFlight.current.clear()
  }, [state.streamEpoch])

  useEffect(() => {
    mounted.current = true
    let current = true
    const generation = state.recoveryGeneration

    void Promise.all([
      api.getWorkspace().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      ),
      api.listConversations().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      ),
    ]).then(([workspaceResult, listResult]) => {
      if (!current) return
      if (!workspaceResult.ok) {
        dispatch({
          type: "listFailed",
          message: errorMessage(workspaceResult.error),
          scope: generation > 0 ? "recovery" : "bootstrap",
          generation,
        })
        return
      }
      if (!listResult.ok) {
        dispatch({
          type: "listFailed",
          message: errorMessage(listResult.error),
          scope: generation > 0 ? "recovery" : "list",
          generation,
        })
        return
      }
      const workspace = workspaceResult.value
      const conversations = listResult.value
      dispatch(
        generation === 0
          ? {
              type: "listSucceeded",
              workspace: workspace.workspace,
              conversations,
              generation,
            }
          : {
              type: "recoveryListSucceeded",
              workspace: workspace.workspace,
              conversations,
              generation,
            }
      )
    })

    return () => {
      current = false
      mounted.current = false
    }
  }, [api, state.recoveryGeneration])

  useEffect(() => {
    const conversationId = state.selectedId
    if (!conversationId) return

    let current = true
    const requestId = ++detailRequestId.current
    dispatch({ type: "detailRequested", conversationId, requestId })
    void api.getConversation(conversationId).then(
      (detail) => {
        if (!current) return
        dispatch({
          type: "detailSucceeded",
          conversationId,
          requestId,
          detail,
        })
      },
      (error: unknown) => {
        if (!current) return
        dispatch({
          type: "detailFailed",
          conversationId,
          requestId,
          message: errorMessage(error),
        })
      }
    )

    return () => {
      current = false
    }
  }, [api, state.detailLoadGeneration, state.selectedId])

  const createConversation = useCallback(async () => {
    if (createInFlight.current || state.recovering) return
    createInFlight.current = true
    dispatch({ type: "createStarted" })
    try {
      const conversation = await api.createConversation()
      if (mounted.current) {
        dispatch({ type: "createSucceeded", conversation })
      }
    } catch (error) {
      if (mounted.current) {
        dispatch({ type: "createFailed", message: errorMessage(error) })
      }
    } finally {
      createInFlight.current = false
    }
  }, [api, state.recovering])

  const select = useCallback((conversationId: string) => {
    dispatch({ type: "selected", conversationId })
  }, [])

  const retrySelectedDetail = useCallback(() => {
    dispatch({ type: "retrySelectedDetail" })
  }, [])

  const updateDraft = useCallback(
    (draft: string) => {
      if (!state.selectedId) return
      dispatch({ type: "draftChanged", conversationId: state.selectedId, draft })
    },
    [state.selectedId]
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const conversationId = state.selectedId
      if (
        !conversationId ||
        sendInFlight.current ||
        state.recovering ||
        isAnyConversationRunning(state)
      ) {
        return
      }
      const ownership = {}
      sendInFlight.current = ownership
      const requestId = `send-${++sendRequestId.current}`
      dispatch({
        type: "sendOptimistic",
        conversationId,
        requestId,
        text,
      })
      try {
        await api.sendMessage(conversationId, text, requestId)
        if (mounted.current) {
          dispatch({ type: "sendSucceeded", conversationId, requestId })
        }
      } catch (error) {
        if (mounted.current) {
          dispatch({
            type: "sendRejected",
            conversationId,
            requestId,
            message: errorMessage(error),
          })
        }
      } finally {
        if (sendInFlight.current === ownership) {
          sendInFlight.current = null
        }
      }
    },
    [api, state]
  )

  const cancelSelected = useCallback(async () => {
    const conversationId = state.selectedId
    const live = conversationId
      ? state.liveByConversationId[conversationId]
      : undefined
    const currentCancelRequestId = conversationId
      ? cancelInFlight.current.get(conversationId)
      : undefined
    if (
      !conversationId ||
      !isConversationActive(state, conversationId) ||
      (currentCancelRequestId !== undefined &&
        live?.cancelRequestId === currentCancelRequestId)
    ) {
      return
    }
    const requestId = `cancel-${++cancelRequestId.current}`
    cancelInFlight.current.set(conversationId, requestId)
    dispatch({ type: "cancelStarted", conversationId, requestId })
    try {
      await api.cancelConversation(conversationId)
      if (mounted.current) {
        dispatch({ type: "cancelSettled", conversationId, requestId })
      }
    } catch (error) {
      if (mounted.current) {
        dispatch({ type: "cancelFailed", conversationId, requestId })
      }
    } finally {
      if (cancelInFlight.current.get(conversationId) === requestId) {
        cancelInFlight.current.delete(conversationId)
      }
    }
  }, [api, state])

  const respondToApproval = useCallback(
    async (requestId: string, decision: ApprovalDecision) => {
      const conversationId = state.selectedId
      const approval = conversationId
        ? selectApproval(state, conversationId)
        : null
      if (
        !conversationId ||
        approval?.id !== requestId ||
        approvalInFlight.current.has(requestId)
      ) {
        return
      }
      approvalInFlight.current.add(requestId)
      try {
        await api.respondToApproval(conversationId, requestId, decision)
        if (mounted.current) {
          dispatch({ type: "approvalResolved", conversationId, requestId })
        }
      } catch (error) {
        if (mounted.current) {
          dispatch({
            type: "approvalFailed",
            conversationId,
            requestId,
            expired:
              error instanceof TaskMuxApiError &&
              error.code === "approval_expired",
          })
        }
        throw error
      } finally {
        approvalInFlight.current.delete(requestId)
      }
    },
    [api, state]
  )

  const value = useMemo<ConversationStore>(() => {
    const conversations = state.order.flatMap((id) => {
      const conversation = state.summariesById[id]
      return conversation ? [conversation] : []
    })
    const selectedConversation = state.selectedId
      ? (state.summariesById[state.selectedId] ?? null)
      : null
    const selectedDetail = state.selectedId
      ? (state.detailsById[state.selectedId] ?? null)
      : null
    return {
      state,
      conversations,
      selectedConversation,
      selectedDetail,
      createConversation,
      select,
      retrySelectedDetail,
      updateDraft,
      sendMessage,
      cancelSelected,
      respondToApproval,
    }
  }, [
    cancelSelected,
    createConversation,
    respondToApproval,
    retrySelectedDetail,
    select,
    sendMessage,
    state,
    updateDraft,
  ])

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  )
}

export function useConversations(): ConversationStore {
  const context = useContext(ConversationContext)
  if (!context) {
    throw new Error("useConversations must be used within ConversationProvider")
  }
  return context
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message
    ? value.message
    : "请求失败，请稍后重试。"
}
