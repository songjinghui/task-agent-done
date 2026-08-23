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

export type ConversationState = {
  workspace: string | null
  summariesById: Record<string, ConversationSummary>
  order: string[]
  selectedId: string | null
  detailsById: Record<string, ConversationDetail>
  loading: ConversationLoadingState
  error: string | null
  errorScope: "list" | "create" | "detail" | null
  detailRequest: { conversationId: string; requestId: number } | null
  detailLoadGeneration: number
  lastEventSeq: number
  streamStatus: "connecting" | "connected" | "disconnected"
  liveByConversationId: Record<string, LiveConversationState>
}

export type LiveConversationState = {
  status: ConversationStatus | null
  activeTurnId: string | null
  textByTurnId: Record<string, string>
  toolsById: Record<string, ToolStatus>
  toolOrder: string[]
  approval: ApprovalRequest | null
  transientTurns: MessageTurn[]
  pendingSend: {
    requestId: string
    optimisticTurnId: string
    previousStatus: ConversationSummary["status"]
    acceptedByEvent: boolean
  } | null
  error: string | null
}

export const initialConversationState: ConversationState = {
  workspace: null,
  summariesById: {},
  order: [],
  selectedId: null,
  detailsById: {},
  loading: { list: true, create: false, detail: false },
  error: null,
  errorScope: null,
  detailRequest: null,
  detailLoadGeneration: 0,
  lastEventSeq: 0,
  streamStatus: "connecting",
  liveByConversationId: {},
}

export type ConversationAction =
  | {
      type: "listSucceeded"
      workspace: string
      conversations: ConversationSummary[]
    }
  | { type: "listFailed"; message: string }
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

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction
): ConversationState {
  switch (action.type) {
    case "listSucceeded": {
      const summariesById = Object.fromEntries(
        action.conversations.map((conversation) => {
          const liveStatus = state.liveByConversationId[conversation.id]?.status
          return [
            conversation.id,
            liveStatus ? { ...conversation, status: liveStatus } : conversation,
          ]
        })
      )
      const order = action.conversations.map((conversation) => conversation.id)
      return {
        ...state,
        workspace: action.workspace,
        summariesById,
        order,
        selectedId: order[0] ?? null,
        loading: { ...state.loading, list: false },
        error: null,
        errorScope: null,
      }
    }
    case "listFailed":
      return {
        ...state,
        loading: { ...state.loading, list: false },
        error: action.message,
        errorScope: "list",
      }
    case "createStarted":
      return {
        ...state,
        loading: { ...state.loading, create: true },
        error: null,
        errorScope: null,
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
        selectedId: action.conversation.id,
        loading: { ...state.loading, create: false },
        error: null,
        errorScope: null,
      }
    case "createFailed":
      return {
        ...state,
        loading: { ...state.loading, create: false },
        error: action.message,
        errorScope: "create",
      }
    case "selected":
      if (!state.summariesById[action.conversationId]) return state
      if (state.selectedId === action.conversationId) return state
      return {
        ...state,
        selectedId: action.conversationId,
        error: null,
        errorScope: null,
      }
    case "retrySelectedDetail":
      if (
        !state.selectedId ||
        state.errorScope !== "detail" ||
        state.loading.detail
      ) {
        return state
      }
      return {
        ...state,
        loading: { ...state.loading, detail: true },
        error: null,
        errorScope: null,
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
        },
        error: null,
        errorScope: null,
      }
    case "detailSucceeded":
      if (!isCurrentDetailRequest(state, action)) return state
      return {
        ...state,
        detailsById: {
          ...state.detailsById,
          [action.conversationId]: action.detail,
        },
        loading: { ...state.loading, detail: false },
        detailRequest: null,
        error: null,
        errorScope: null,
      }
    case "detailFailed":
      if (!isCurrentDetailRequest(state, action)) return state
      return {
        ...state,
        loading: { ...state.loading, detail: false },
        detailRequest: null,
        error: action.message,
        errorScope: "detail",
      }
    case "streamStatusChanged":
      return state.streamStatus === action.status
        ? state
        : { ...state, streamStatus: action.status }
    case "eventReceived":
      return reduceEvent(state, action.envelope)
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
            previousStatus,
            acceptedByEvent: false,
          },
          error: null,
        }
      )
    }
    case "sendSucceeded": {
      const live = state.liveByConversationId[action.conversationId]
      if (live?.pendingSend?.requestId !== action.requestId) return state
      return withLive(state, action.conversationId, {
        ...live,
        pendingSend: null,
      })
    }
    case "sendRejected": {
      const live = state.liveByConversationId[action.conversationId]
      const pending = live?.pendingSend
      if (!live || !pending || pending.requestId !== action.requestId) return state
      const accepted = pending.acceptedByEvent || live.activeTurnId !== null
      const nextLive: LiveConversationState = {
        ...live,
        status: accepted ? "running" : pending.previousStatus,
        transientTurns: accepted
          ? live.transientTurns
          : live.transientTurns.filter(
              (turn) => turn.id !== pending.optimisticTurnId
            ),
        pendingSend: null,
        error: live.error,
      }
      const next = withLive(state, action.conversationId, nextLive)
      return accepted
        ? next
        : withSummaryStatus(next, action.conversationId, pending.previousStatus)
    }
    case "approvalResolved": {
      const live = state.liveByConversationId[action.conversationId]
      if (!live || live.approval?.id !== action.requestId) return state
      return withLive(state, action.conversationId, {
        ...live,
        approval: null,
      })
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
  const live = liveFor(stateWithSeq, conversationId)
  const payload = envelope.payload

  switch (payload.type) {
    case "turn_started": {
      const nextLive: LiveConversationState = {
        ...live,
        status: "running",
        activeTurnId: payload.turnId,
        error: null,
        pendingSend: live.pendingSend
          ? { ...live.pendingSend, acceptedByEvent: true }
          : null,
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
        pendingSend: live.pendingSend
          ? { ...live.pendingSend, acceptedByEvent: true }
          : null,
      }
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "running"),
        conversationId,
        nextLive
      )
    }
    case "tool_status": {
      const known = Boolean(live.toolsById[payload.tool.id])
      return withLive(stateWithSeq, conversationId, {
        ...live,
        toolsById: { ...live.toolsById, [payload.tool.id]: payload.tool },
        toolOrder: known
          ? live.toolOrder
          : [...live.toolOrder, payload.tool.id],
      })
    }
    case "approval_requested":
      return withLive(stateWithSeq, conversationId, {
        ...live,
        approval: payload.request,
      })
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
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "idle"),
        conversationId,
        terminalLive(live, { status: "idle", transientTurns })
      )
    }
    case "turn_interrupted":
      if (live.activeTurnId && live.activeTurnId !== payload.turnId) {
        return stateWithSeq
      }
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "interrupted"),
        conversationId,
        terminalLive(live, { status: "interrupted" })
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
      return withLive(
        withSummaryStatus(stateWithSeq, conversationId, "failed"),
        conversationId,
        terminalLive(live, { status: "failed", error: payload.message })
      )
    }
  }
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
    pendingSend: null,
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
    transientTurns: [],
    pendingSend: null,
    error: null,
  }
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
      live?.pendingSend ||
      state.summariesById[conversationId]?.status === "running"
  )
}

export function isAnyConversationRunning(state: ConversationState): boolean {
  return state.order.some((id) => isConversationActive(state, id)) ||
    Object.entries(state.liveByConversationId).some(
      ([id]) => !state.summariesById[id] && isConversationActive(state, id)
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
  const sendInFlight = useRef(false)
  const cancelInFlight = useRef<string | null>(null)
  const approvalInFlight = useRef(new Set<string>())
  const sendRequestId = useRef(0)
  const detailRequestId = useRef(0)
  useEventStream(dispatch)

  useEffect(() => {
    mounted.current = true
    let current = true

    void Promise.all([api.getWorkspace(), api.listConversations()]).then(
      ([workspace, conversations]) => {
        if (!current) return
        dispatch({
          type: "listSucceeded",
          workspace: workspace.workspace,
          conversations,
        })
      },
      (error: unknown) => {
        if (!current) return
        dispatch({ type: "listFailed", message: errorMessage(error) })
      }
    )

    return () => {
      current = false
      mounted.current = false
    }
  }, [api])

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
    if (createInFlight.current) return
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
  }, [api])

  const select = useCallback((conversationId: string) => {
    dispatch({ type: "selected", conversationId })
  }, [])

  const retrySelectedDetail = useCallback(() => {
    dispatch({ type: "retrySelectedDetail" })
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      const conversationId = state.selectedId
      if (
        !conversationId ||
        sendInFlight.current ||
        isAnyConversationRunning(state)
      ) {
        throw new Error("当前已有会话正在运行。")
      }
      sendInFlight.current = true
      const requestId = `send-${++sendRequestId.current}`
      dispatch({
        type: "sendOptimistic",
        conversationId,
        requestId,
        text,
      })
      try {
        await api.sendMessage(conversationId, text)
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
        throw error
      } finally {
        sendInFlight.current = false
      }
    },
    [api, state]
  )

  const cancelSelected = useCallback(async () => {
    const conversationId = state.selectedId
    if (
      !conversationId ||
      !isConversationActive(state, conversationId) ||
      cancelInFlight.current === conversationId
    ) {
      return
    }
    cancelInFlight.current = conversationId
    try {
      await api.cancelConversation(conversationId)
    } finally {
      if (cancelInFlight.current === conversationId) {
        cancelInFlight.current = null
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
        if (
          mounted.current &&
          error instanceof TaskMuxApiError &&
          error.code === "approval_expired"
        ) {
          dispatch({ type: "approvalResolved", conversationId, requestId })
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
