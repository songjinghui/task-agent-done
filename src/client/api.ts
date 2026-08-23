import type {
  ApprovalDecision,
  ConversationDetail,
  ConversationSummary,
} from "../shared/contracts.js"

export type TaskMuxHealth =
  | { status: "ok" }
  | {
      status: "degraded"
      error: { code: string; message: string }
    }

export type WorkspaceInfo = {
  workspace: string
}

export type AcceptedMessage = {
  accepted: true
}

export interface TaskMuxApi {
  getHealth(): Promise<TaskMuxHealth>
  getWorkspace(): Promise<WorkspaceInfo>
  listConversations(): Promise<ConversationSummary[]>
  createConversation(): Promise<ConversationSummary>
  getConversation(conversationId: string): Promise<ConversationDetail>
  sendMessage(
    conversationId: string,
    text: string,
    clientRequestId?: string
  ): Promise<AcceptedMessage>
  cancelConversation(conversationId: string): Promise<void>
  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void>
}

export class TaskMuxApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = "TaskMuxApiError"
    this.code = code
    this.status = status
  }
}

export function createTaskMuxApi(
  fetcher: typeof fetch = globalThis.fetch
): TaskMuxApi {
  const jsonRequest = async <T>(
    path: string,
    decode: (value: unknown) => T | null,
    init?: RequestInit
  ): Promise<T> => {
    const response = await fetcher(path, init)
    if (!response.ok) throw await responseError(response)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw invalidResponse(response.status)
    }
    const decoded = decode(body)
    if (decoded === null) throw invalidResponse(response.status)
    return decoded
  }

  const bodylessRequest = async (
    path: string,
    init?: RequestInit
  ): Promise<void> => {
    const response = await fetcher(path, init)
    if (!response.ok) throw await responseError(response)
    if (response.status !== 204) throw invalidResponse(response.status)

    let body: string
    try {
      body = await response.text()
    } catch {
      throw invalidResponse(response.status)
    }
    if (body.length !== 0) throw invalidResponse(response.status)
  }

  return {
    getHealth: () => jsonRequest("/api/health", decodeHealth),
    getWorkspace: () => jsonRequest("/api/workspace", decodeWorkspace),
    listConversations: () =>
      jsonRequest("/api/conversations", decodeConversationList),
    createConversation: () =>
      jsonRequest("/api/conversations", decodeConversationSummary, {
        method: "POST",
      }),
    getConversation: (conversationId) =>
      jsonRequest(
        conversationPath(conversationId),
        (value) => decodeConversationDetail(value, conversationId)
      ),
    sendMessage: (conversationId, text, clientRequestId) =>
      jsonRequest(
        `${conversationPath(conversationId)}/messages`,
        decodeAcceptedMessage,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
          }),
        }
      ),
    cancelConversation: (conversationId) =>
      bodylessRequest(
        `${conversationPath(conversationId)}/cancel`,
        { method: "POST" }
      ),
    respondToApproval: (conversationId, requestId, decision) =>
      bodylessRequest(
        `${conversationPath(conversationId)}/approvals/${encodeURIComponent(requestId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      ),
  }
}

function conversationPath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}`
}

async function responseError(response: Response): Promise<TaskMuxApiError> {
  const fallback = new TaskMuxApiError(
    "request_failed",
    `Request failed with status ${response.status}.`,
    response.status
  )

  try {
    const body = (await response.json()) as unknown
    if (!isRecord(body) || !isRecord(body.error)) return fallback
    const { code, message } = body.error
    if (!nonBlankString(code) || !nonBlankString(message)) {
      return fallback
    }
    return new TaskMuxApiError(code, message, response.status)
  } catch {
    return fallback
  }
}

function invalidResponse(status: number): TaskMuxApiError {
  return new TaskMuxApiError(
    "invalid_response",
    "Server returned an invalid response.",
    status
  )
}

function decodeHealth(value: unknown): TaskMuxHealth | null {
  if (!isRecord(value)) return null
  if (value.status === "ok") return { status: "ok" }
  if (
    value.status !== "degraded" ||
    !isRecord(value.error) ||
    !nonBlankString(value.error.code) ||
    !nonBlankString(value.error.message)
  ) {
    return null
  }
  return {
    status: "degraded",
    error: { code: value.error.code, message: value.error.message },
  }
}

function decodeWorkspace(value: unknown): WorkspaceInfo | null {
  if (!isRecord(value) || !nonBlankString(value.workspace)) return null
  return { workspace: value.workspace }
}

function decodeConversationList(
  value: unknown
): ConversationSummary[] | null {
  if (!Array.isArray(value)) return null
  const conversations: ConversationSummary[] = []
  for (const item of value) {
    const conversation = decodeConversationSummary(item)
    if (!conversation) return null
    conversations.push(conversation)
  }
  return conversations
}

function decodeConversationSummary(
  value: unknown
): ConversationSummary | null {
  if (
    !isRecord(value) ||
    !nonBlankString(value.id) ||
    !nonBlankString(value.title) ||
    !isConversationStatus(value.status) ||
    !isDateString(value.createdAt) ||
    !isDateString(value.updatedAt)
  ) {
    return null
  }
  return {
    id: value.id,
    title: value.title,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function decodeConversationDetail(
  value: unknown,
  expectedConversationId: string
): ConversationDetail | null {
  if (
    !isRecord(value) ||
    value.conversationId !== expectedConversationId ||
    !Array.isArray(value.turns)
  ) {
    return null
  }
  const turns: ConversationDetail["turns"] = []
  for (const item of value.turns) {
    const turn = decodeMessageTurn(item)
    if (!turn) return null
    turns.push(turn)
  }
  return { conversationId: expectedConversationId, turns }
}

function decodeMessageTurn(
  value: unknown
): ConversationDetail["turns"][number] | null {
  if (
    !isRecord(value) ||
    !nonBlankString(value.id) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.text !== "string" ||
    (value.status !== "completed" &&
      value.status !== "interrupted" &&
      value.status !== "failed")
  ) {
    return null
  }
  return {
    id: value.id,
    role: value.role,
    text: value.text,
    status: value.status,
  }
}

function decodeAcceptedMessage(value: unknown): AcceptedMessage | null {
  return isRecord(value) && value.accepted === true ? { accepted: true } : null
}

function isConversationStatus(
  value: unknown
): value is ConversationSummary["status"] {
  return (
    value === "idle" ||
    value === "running" ||
    value === "failed" ||
    value === "interrupted"
  )
}

function isDateString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
