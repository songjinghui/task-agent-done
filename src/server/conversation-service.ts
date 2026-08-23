import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  ConversationDetail,
  ConversationEvent,
  ConversationStatus,
  ConversationSummary,
} from "../shared/contracts.js"
import type { AgentAdapter, AgentAdapterEvent } from "./agent/agent-adapter.js"
import {
  ConversationRepository,
  type StoredConversation,
} from "./conversation-repository.js"

const DEFAULT_TITLE = "新会话"
const MAX_PROMPT_CODE_POINTS = 100_000
const MAX_TITLE_CODE_POINTS = 60

type ActiveTurn = {
  externalSessionId: string
  operationId: string
  turnId?: string
  titleCandidate: string
  titleApplied: boolean
}

export type ConversationEventSink = {
  publish(conversationId: string, payload: ConversationEvent): void
}

export type ConversationServiceOptions = {
  repository: ConversationRepository
  adapter: AgentAdapter
  eventSink: ConversationEventSink
  workspace: string
}

export class ConversationServiceError extends Error {
  constructor(
    readonly code:
      | "conversation_not_found"
      | "invalid_prompt"
      | "turn_conflict"
      | "approval_expired",
    message: string
  ) {
    super(message)
    this.name = "ConversationServiceError"
  }
}

export class ConversationService {
  readonly #repository: ConversationRepository
  readonly #adapter: AgentAdapter
  readonly #eventSink: ConversationEventSink
  readonly #workspace: string
  readonly #activeTurns = new Map<string, ActiveTurn>()
  readonly #pendingTurnStarts = new Map<string, ActiveTurn>()
  readonly #cancellationRequests = new Map<string, ActiveTurn>()
  readonly #approvalOwners = new Map<string, string>()
  #activeConversationId: string | null = null

  constructor(options: ConversationServiceOptions) {
    this.#repository = options.repository
    this.#adapter = options.adapter
    this.#eventSink = options.eventSink
    this.#workspace = options.workspace
    this.#adapter.subscribe((event) => this.#handleAdapterEvent(event))
  }

  list(): ConversationSummary[] {
    return this.#repository.list().map(toSummary)
  }

  async create(): Promise<ConversationSummary> {
    const session = await this.#adapter.createSession(this.#workspace)
    return toSummary(
      this.#repository.create({
        id: randomUUID(),
        externalSessionId: session.externalSessionId,
      })
    )
  }

  async getDetail(conversationId: string): Promise<ConversationDetail> {
    const conversation = this.#requireConversation(conversationId)
    const turns = await this.#adapter.readSession(conversation.externalSessionId)
    return { conversationId, turns }
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const conversation = this.#requireConversation(conversationId)
    validatePrompt(text)
    if (this.#activeConversationId !== null) {
      throw new ConversationServiceError(
        "turn_conflict",
        "Another conversation already has an active turn."
      )
    }

    const ownership: ActiveTurn = {
      externalSessionId: conversation.externalSessionId,
      operationId: randomUUID(),
      titleCandidate: titleFromPrompt(text),
      titleApplied: false,
    }
    this.#activeTurns.set(conversationId, ownership)
    this.#activeConversationId = conversationId
    this.#pendingTurnStarts.set(conversationId, ownership)

    let accepted: { turnId: string }
    try {
      this.#repository.setStatus(conversationId, "running")
      await this.#adapter.resumeSession(conversation.externalSessionId)
      if (this.#activeTurns.get(conversationId) !== ownership) return
      accepted = await this.#adapter.sendText(
        conversation.externalSessionId,
        text,
        ownership.operationId
      )
    } catch (error) {
      this.#finishActiveTurn(conversationId, "failed", ownership)
      throw error
    } finally {
      if (this.#pendingTurnStarts.get(conversationId) === ownership) {
        this.#pendingTurnStarts.delete(conversationId)
      }
    }

    if (this.#activeTurns.get(conversationId) !== ownership) return
    this.#acceptActiveTurn(conversationId, ownership, accepted.turnId)

    if (
      this.#cancellationRequests.get(conversationId) === ownership &&
      this.#activeTurns.get(conversationId) === ownership
    ) {
      await this.#dispatchCancellation(conversationId, ownership)
    }
  }

  async cancel(conversationId: string): Promise<void> {
    const conversation = this.#requireConversation(conversationId)
    const ownership = this.#activeTurns.get(conversationId)
    if (!ownership || ownership.externalSessionId !== conversation.externalSessionId) {
      return
    }
    await this.#requestCancellation(conversationId, ownership)
  }

  async respondToApproval(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    this.#requireConversation(conversationId)
    if (this.#approvalOwners.get(requestId) !== conversationId) {
      throw new ConversationServiceError(
        "approval_expired",
        "Approval request is no longer pending for this conversation."
      )
    }
    try {
      await this.#adapter.respondToApproval(requestId, decision)
    } finally {
      if (this.#approvalOwners.get(requestId) === conversationId) {
        this.#approvalOwners.delete(requestId)
      }
    }
  }

  recoverStartup(): number {
    return this.#repository.interruptRunning()
  }

  async handleClientDisconnect(): Promise<void> {
    const conversationId = this.#activeConversationId
    if (conversationId === null) return
    const ownership = this.#activeTurns.get(conversationId)
    if (!ownership) return
    await this.#requestCancellation(conversationId, ownership)
  }

  #requireConversation(conversationId: string): StoredConversation {
    const conversation = this.#repository.getById(conversationId)
    if (!conversation) {
      throw new ConversationServiceError(
        "conversation_not_found",
        "Conversation not found."
      )
    }
    return conversation
  }

  async #requestCancellation(
    conversationId: string,
    ownership: ActiveTurn
  ): Promise<void> {
    if (this.#cancellationRequests.get(conversationId) === ownership) return
    this.#cancellationRequests.set(conversationId, ownership)
    if (this.#pendingTurnStarts.get(conversationId) === ownership) return
    await this.#dispatchCancellation(conversationId, ownership)
  }

  async #dispatchCancellation(
    conversationId: string,
    ownership: ActiveTurn
  ): Promise<void> {
    try {
      await this.#adapter.cancelTurn(ownership.externalSessionId)
    } catch (error) {
      if (this.#activeTurns.get(conversationId) === ownership) {
        if (this.#cancellationRequests.get(conversationId) === ownership) {
          this.#cancellationRequests.delete(conversationId)
        }
        this.#eventSink.publish(conversationId, {
          type: "error",
          code: "turn_cancel_failed",
          message: "Failed to cancel the active turn.",
          terminal: false,
        })
      }
      throw error
    }
  }

  #handleAdapterEvent(event: AgentAdapterEvent): void {
    const conversation = this.#repository.getByExternalSessionId(
      event.externalSessionId
    )
    if (!conversation) return

    const ownership = this.#activeTurns.get(conversation.id)
    if (
      turnBoundPayload(event.payload) &&
      (!ownership || event.operationId !== ownership.operationId)
    ) {
      return
    }
    if (event.payload.type === "approval_requested") {
      this.#approvalOwners.set(event.payload.request.id, conversation.id)
    } else if (
      event.payload.type === "turn_started" && ownership
    ) {
      if (!this.#acceptActiveTurn(conversation.id, ownership, event.payload.turnId)) {
        return
      }
    } else if (event.payload.type === "text_delta" && ownership) {
      if (!this.#acceptActiveTurn(conversation.id, ownership, event.payload.turnId)) {
        return
      }
    } else if (
      event.payload.type === "turn_completed" && ownership
    ) {
      if (!this.#acceptActiveTurn(conversation.id, ownership, event.payload.turnId)) {
        return
      }
      this.#finishActiveTurn(conversation.id, "idle", ownership)
    } else if (
      event.payload.type === "turn_interrupted" && ownership
    ) {
      if (!this.#acceptActiveTurn(conversation.id, ownership, event.payload.turnId)) {
        return
      }
      this.#finishActiveTurn(conversation.id, "interrupted", ownership)
    } else if (
      event.payload.type === "error" &&
      event.payload.terminal &&
      event.payload.scope === "turn" &&
      ownership
    ) {
      if (!this.#acceptActiveTurn(conversation.id, ownership, event.payload.turnId)) {
        return
      }
      this.#finishActiveTurn(conversation.id, "failed", ownership)
    } else if (
      event.payload.type === "error" &&
      event.payload.terminal &&
      event.payload.scope === "session" &&
      ownership?.externalSessionId === event.externalSessionId
    ) {
      this.#finishActiveTurn(conversation.id, "failed", ownership)
    }

    this.#eventSink.publish(conversation.id, event.payload)
  }

  #acceptActiveTurn(
    conversationId: string,
    ownership: ActiveTurn,
    turnId: string
  ): boolean {
    if (this.#activeTurns.get(conversationId) !== ownership) return false
    if (ownership.turnId !== undefined && ownership.turnId !== turnId) return false
    ownership.turnId = turnId
    if (!ownership.titleApplied) {
      ownership.titleApplied = true
      try {
        const conversation = this.#repository.getById(conversationId)
        if (conversation?.title === DEFAULT_TITLE) {
          this.#repository.updateTitle(conversationId, ownership.titleCandidate)
        }
      } catch {
        this.#eventSink.publish(conversationId, {
          type: "error",
          code: "conversation_title_update_failed",
          message: "Failed to update the conversation title.",
          terminal: false,
        })
      }
    }
    return true
  }

  #finishActiveTurn(
    conversationId: string,
    status: ConversationStatus,
    expectedOwnership: ActiveTurn
  ): void {
    if (this.#activeTurns.get(conversationId) !== expectedOwnership) return

    try {
      this.#repository.setStatus(conversationId, status)
    } finally {
      this.#activeTurns.delete(conversationId)
      if (this.#cancellationRequests.get(conversationId) === expectedOwnership) {
        this.#cancellationRequests.delete(conversationId)
      }
      this.#clearApprovalOwners(conversationId)
      if (this.#activeConversationId === conversationId) {
        this.#activeConversationId = null
      }
    }
  }

  #clearApprovalOwners(conversationId: string): void {
    for (const [requestId, ownerId] of this.#approvalOwners) {
      if (ownerId === conversationId) {
        this.#approvalOwners.delete(requestId)
      }
    }
  }
}

function toSummary(conversation: StoredConversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }
}

function validatePrompt(text: string): void {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    [...text].length > MAX_PROMPT_CODE_POINTS
  ) {
    throw new ConversationServiceError(
      "invalid_prompt",
      "Prompt must contain between 1 and 100,000 Unicode code points."
    )
  }
}

function titleFromPrompt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim()
  return [...collapsed].slice(0, MAX_TITLE_CODE_POINTS).join("")
}

function turnBoundPayload(payload: ConversationEvent): boolean {
  return (
    payload.type === "turn_started" ||
    payload.type === "text_delta" ||
    payload.type === "tool_status" ||
    payload.type === "approval_requested" ||
    payload.type === "turn_completed" ||
    payload.type === "turn_interrupted" ||
    (payload.type === "error" && payload.terminal && payload.scope === "turn")
  )
}
