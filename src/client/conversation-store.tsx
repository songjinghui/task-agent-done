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
  ConversationDetail,
  ConversationSummary,
} from "../shared/contracts.js"
import type { TaskMuxApi } from "./api.js"

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
  detailRequest: { conversationId: string; requestId: number } | null
}

export const initialConversationState: ConversationState = {
  workspace: null,
  summariesById: {},
  order: [],
  selectedId: null,
  detailsById: {},
  loading: { list: true, create: false, detail: false },
  error: null,
  detailRequest: null,
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

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction
): ConversationState {
  switch (action.type) {
    case "listSucceeded": {
      const summariesById = Object.fromEntries(
        action.conversations.map((conversation) => [conversation.id, conversation])
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
      }
    }
    case "listFailed":
      return {
        ...state,
        loading: { ...state.loading, list: false },
        error: action.message,
      }
    case "createStarted":
      return {
        ...state,
        loading: { ...state.loading, create: true },
        error: null,
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
      }
    case "createFailed":
      return {
        ...state,
        loading: { ...state.loading, create: false },
        error: action.message,
      }
    case "selected":
      if (!state.summariesById[action.conversationId]) return state
      return {
        ...state,
        selectedId: action.conversationId,
        error: null,
      }
    case "detailRequested":
      if (state.selectedId !== action.conversationId) return state
      return {
        ...state,
        loading: { ...state.loading, detail: true },
        detailRequest: action,
        error: null,
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
      }
    case "detailFailed":
      if (!isCurrentDetailRequest(state, action)) return state
      return {
        ...state,
        loading: { ...state.loading, detail: false },
        detailRequest: null,
        error: action.message,
      }
  }
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
  const detailRequestId = useRef(0)

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
  }, [api, state.selectedId])

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
    }
  }, [createConversation, select, state])

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
