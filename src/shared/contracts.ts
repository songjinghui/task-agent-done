export type ConversationStatus = "idle" | "running" | "failed" | "interrupted"

export type ConversationSummary = {
  id: string
  title: string
  status: ConversationStatus
  createdAt: string
  updatedAt: string
}

export type MessageTurn = {
  id: string
  role: "user" | "assistant"
  text: string
  status: "completed" | "interrupted" | "failed"
}

export type ConversationDetail = {
  conversationId: string
  turns: MessageTurn[]
}

export type ToolStatus = {
  id: string
  label: string
  status: "running" | "completed" | "failed" | "declined"
}

export type ApprovalRequest = {
  id: string
  kind: "command" | "file_change"
  label: string
}

export type ApprovalDecision = "accept" | "decline"

export type ConversationErrorEvent =
  | { type: "error"; code: string; message: string; terminal: false }
  | {
      type: "error"
      code: string
      message: string
      terminal: true
      scope: "turn"
      turnId: string
    }
  | {
      type: "error"
      code: string
      message: string
      terminal: true
      scope: "session"
    }

export type ConversationEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "tool_status"; tool: ToolStatus }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "turn_completed"; turnId: string }
  | { type: "turn_interrupted"; turnId: string }
  | ConversationErrorEvent

export type ConversationEventEnvelope = {
  conversationId: string
  seq: number
  payload: ConversationEvent
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "decline"
}
