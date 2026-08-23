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
    text: string
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
  const request = async <T>(
    path: string,
    init?: RequestInit,
    empty = false
  ): Promise<T> => {
    const response = await fetcher(path, init)
    if (!response.ok) throw await responseError(response)
    if (empty) return undefined as T
    return (await response.json()) as T
  }

  return {
    getHealth: () => request<TaskMuxHealth>("/api/health"),
    getWorkspace: () => request<WorkspaceInfo>("/api/workspace"),
    listConversations: () =>
      request<ConversationSummary[]>("/api/conversations"),
    createConversation: () =>
      request<ConversationSummary>("/api/conversations", { method: "POST" }),
    getConversation: (conversationId) =>
      request<ConversationDetail>(conversationPath(conversationId)),
    sendMessage: (conversationId, text) =>
      request<AcceptedMessage>(`${conversationPath(conversationId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    cancelConversation: (conversationId) =>
      request<void>(
        `${conversationPath(conversationId)}/cancel`,
        { method: "POST" },
        true
      ),
    respondToApproval: (conversationId, requestId, decision) =>
      request<void>(
        `${conversationPath(conversationId)}/approvals/${encodeURIComponent(requestId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
        true
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
