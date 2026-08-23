import type { ServerResponse } from "node:http"
import type { FastifyInstance, FastifyReply } from "fastify"
import { isApprovalDecision } from "../shared/contracts.js"
import {
  ConversationService,
  ConversationServiceError,
} from "./conversation-service.js"
import type { EventHub } from "./event-hub.js"

const MAX_CLIENT_REQUEST_ID_CODE_POINTS = 128

export type AppError = {
  code: string
  message: string
}

export type AppHealth =
  | { status: "ok" }
  | { status: "degraded"; error: AppError }

export type HttpRoutesOptions = {
  workspace: string
  service: ConversationService
  eventHub: EventHub
  health: () => AppHealth
}

type SseConnection = {
  response: ServerResponse
  unsubscribe: () => void
  closed: boolean
}

export function registerHttpRoutes(
  app: FastifyInstance,
  options: HttpRoutesOptions
): void {
  const sseConnections = new Set<SseConnection>()
  let serverClosing = false

  app.addHook("preClose", async () => {
    serverClosing = true
    for (const connection of [...sseConnections]) {
      closeSseConnection(connection, false)
      connection.response.end()
    }
  })

  app.get("/api/health", async (_request, reply) => {
    const health = options.health()
    return reply.code(health.status === "ok" ? 200 : 503).send(health)
  })

  app.get("/api/workspace", async () => ({ workspace: options.workspace }))

  app.get("/api/conversations", async () => options.service.list())

  app.post("/api/conversations", async (request, reply) => {
    requireEmptyBody(request.body)
    const conversation = await options.service.create()
    return reply.code(201).send(conversation)
  })

  app.get("/api/conversations/:id", async (request) => {
    const { id } = conversationParams(request.params)
    return options.service.getDetail(id)
  })

  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = conversationParams(request.params)
    const { text, clientRequestId } = messageBody(request.body)
    await options.service.sendText(id, text, clientRequestId)
    return reply.code(202).send({ accepted: true })
  })

  app.post("/api/conversations/:id/cancel", async (request, reply) => {
    const { id } = conversationParams(request.params)
    requireEmptyBody(request.body)
    await options.service.cancel(id)
    return reply.code(204).send()
  })

  app.post(
    "/api/conversations/:id/approvals/:requestId",
    async (request, reply) => {
      const { id, requestId } = approvalParams(request.params)
      const decision = approvalBody(request.body)
      await options.service.respondToApproval(id, requestId, decision)
      return reply.code(204).send()
    }
  )

  app.get("/api/events", async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    reply.raw.flushHeaders()

    const connection: SseConnection = {
      response: reply.raw,
      unsubscribe: () => {},
      closed: false,
    }
    connection.unsubscribe = options.eventHub.subscribe((event) => {
      const data = JSON.stringify(event)
      if (!connection.closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`id: ${event.seq}\ndata: ${data}\n\n`)
      }
    })
    sseConnections.add(connection)

    const onClose = () => closeSseConnection(connection, !serverClosing)
    request.raw.once("close", onClose)
    reply.raw.once("close", onClose)
  })

  app.setNotFoundHandler(async (_request, reply) => {
    return sendError(reply, 404, "route_not_found", "Route not found.")
  })

  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = mapError(error)
    return sendError(reply, mapped.statusCode, mapped.code, mapped.message)
  })

  function closeSseConnection(
    connection: SseConnection,
    clientInitiated: boolean
  ): void {
    if (connection.closed) return
    connection.closed = true
    connection.unsubscribe()
    sseConnections.delete(connection)

    if (clientInitiated && sseConnections.size === 0) {
      void options.service.handleClientDisconnect().catch(() => {})
    }
  }
}

class HttpInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "HttpInputError"
  }
}

function conversationParams(value: unknown): { id: string } {
  if (!isRecord(value) || !nonBlankString(value.id)) {
    throw new HttpInputError(
      "invalid_conversation_id",
      "Conversation ID must be a non-empty string."
    )
  }
  return { id: value.id }
}

function approvalParams(value: unknown): { id: string; requestId: string } {
  const { id } = conversationParams(value)
  if (!isRecord(value) || !nonBlankString(value.requestId)) {
    throw new HttpInputError(
      "invalid_request_id",
      "Approval request ID must be a non-empty string."
    )
  }
  return { id, requestId: value.requestId }
}

function messageBody(value: unknown): {
  text: string
  clientRequestId?: string
} {
  const keys = isRecord(value) ? Object.keys(value) : []
  if (
    !isRecord(value) ||
    (keys.length !== 1 && keys.length !== 2) ||
    !keys.includes("text") ||
    keys.some((key) => key !== "text" && key !== "clientRequestId") ||
    typeof value.text !== "string" ||
    (value.clientRequestId !== undefined &&
      (!nonBlankString(value.clientRequestId) ||
        [...value.clientRequestId].length > MAX_CLIENT_REQUEST_ID_CODE_POINTS))
  ) {
    throw new HttpInputError(
      "invalid_request_body",
      "Request body must contain text and an optional client request ID."
    )
  }
  return value.clientRequestId === undefined
    ? { text: value.text }
    : { text: value.text, clientRequestId: value.clientRequestId }
}

function approvalBody(value: unknown): "accept" | "decline" {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !isApprovalDecision(value.decision)
  ) {
    throw new HttpInputError(
      "invalid_approval_decision",
      "Approval decision must be accept or decline."
    )
  }
  return value.decision
}

function requireEmptyBody(value: unknown): void {
  if (value !== undefined) {
    throw new HttpInputError(
      "invalid_request_body",
      "Request body must be empty."
    )
  }
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string
) {
  return reply.code(statusCode).send({ error: { code, message } })
}

function mapError(value: unknown): {
  statusCode: number
  code: string
  message: string
} {
  const error = normalizeError(value)
  if (error instanceof HttpInputError) {
    return { statusCode: 400, code: error.code, message: error.message }
  }

  if (error instanceof ConversationServiceError) {
    const statusCode = {
      conversation_not_found: 404,
      invalid_prompt: 400,
      turn_conflict: 409,
      approval_expired: 409,
    }[error.code]
    return { statusCode, code: error.code, message: error.message }
  }

  if (isMalformedJsonError(error)) {
    return {
      statusCode: 400,
      code: "invalid_request_body",
      message: "Request body must be valid JSON.",
    }
  }
  if (isRejectedBodyError(error)) {
    return {
      statusCode: 400,
      code: "invalid_request_body",
      message: "Request body is not supported.",
    }
  }

  const code = errorCode(error)
  if (code === "approval_expired") {
    return {
      statusCode: 409,
      code,
      message: "Approval request is no longer pending.",
    }
  }
  if (UNAVAILABLE_CODES.has(code)) {
    return {
      statusCode: 503,
      code,
      message: "Agent service is unavailable.",
    }
  }

  return {
    statusCode: 500,
    code: "internal_error",
    message: "Internal server error.",
  }
}

function normalizeError(
  value: unknown
): Error & { code?: string; statusCode?: number } {
  return value instanceof Error
    ? (value as Error & { code?: string; statusCode?: number })
    : new Error("unknown_error")
}

function isMalformedJsonError(error: Error & { code?: string }): boolean {
  return error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
}

function isRejectedBodyError(error: Error & { code?: string }): boolean {
  return (
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
    error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  )
}

function errorCode(error: Error & { code?: string }): string {
  return typeof error.code === "string" ? error.code : error.message
}

const UNAVAILABLE_CODES = new Set([
  "codex_not_found",
  "codex_version_unsupported",
  "codex_not_authenticated",
  "app_server_exited",
  "app_server_not_started",
  "app_server_stopped",
  "app_server_request_timeout",
  "thread_unavailable",
  "turn_start_failed",
])
