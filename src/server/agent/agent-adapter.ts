import type {
  ApprovalDecision,
  ConversationEvent,
  MessageTurn,
} from "../../shared/contracts.js"

export type AgentAdapterEvent = {
  externalSessionId: string
  payload: ConversationEvent
}

export interface AgentAdapter {
  createSession(workspace: string): Promise<{ externalSessionId: string }>
  readSession(externalSessionId: string): Promise<MessageTurn[]>
  resumeSession(externalSessionId: string): Promise<void>
  sendText(externalSessionId: string, text: string): Promise<void>
  cancelTurn(externalSessionId: string): Promise<void>
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  subscribe(handler: (event: AgentAdapterEvent) => void): () => void
}
