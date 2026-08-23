import { useEffect, useRef, useState, type Dispatch } from "react"
import type {
  ApprovalRequest,
  ConversationErrorEvent,
  ConversationEvent,
  ConversationEventEnvelope,
  ToolStatus,
} from "../shared/contracts.js"
import type { ConversationAction } from "./conversation-store.js"

export type EventStreamState = {
  status: "connecting" | "connected" | "disconnected"
}

export function useEventStream(
  dispatch: Dispatch<ConversationAction>
): EventStreamState {
  const [state, setState] = useState<EventStreamState>({
    status: "connecting",
  })
  const largestSeq = useRef(0)

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setState({ status: "disconnected" })
      return
    }

    const source = new EventSource("/api/events")
    setState({ status: "connecting" })
    dispatch({ type: "streamStatusChanged", status: "connecting" })

    source.onopen = () => {
      setState({ status: "connected" })
      dispatch({ type: "streamStatusChanged", status: "connected" })
    }
    source.onerror = () => {
      setState({ status: "disconnected" })
      dispatch({ type: "streamStatusChanged", status: "disconnected" })
    }
    source.onmessage = (message) => {
      const envelope = decodeEnvelope(message.data)
      if (!envelope || envelope.seq <= largestSeq.current) return
      largestSeq.current = envelope.seq
      dispatch({ type: "eventReceived", envelope })
    }

    return () => source.close()
  }, [dispatch])

  return state
}

function decodeEnvelope(data: string): ConversationEventEnvelope | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (
    !isRecord(value) ||
    !nonBlankString(value.conversationId) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) <= 0
  ) {
    return null
  }
  const payload = decodePayload(value.payload)
  return payload
    ? { conversationId: value.conversationId, seq: value.seq as number, payload }
    : null
}

function decodePayload(value: unknown): ConversationEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null
  switch (value.type) {
    case "turn_started":
    case "turn_completed":
    case "turn_interrupted":
      return nonBlankString(value.turnId)
        ? { type: value.type, turnId: value.turnId }
        : null
    case "text_delta":
      return nonBlankString(value.turnId) && typeof value.text === "string"
        ? { type: "text_delta", turnId: value.turnId, text: value.text }
        : null
    case "tool_status": {
      const tool = decodeTool(value.tool)
      return tool ? { type: "tool_status", tool } : null
    }
    case "approval_requested": {
      const request = decodeApproval(value.request)
      return request ? { type: "approval_requested", request } : null
    }
    case "error": {
      const error = decodeError(value)
      return error
    }
    default:
      return null
  }
}

function decodeTool(value: unknown): ToolStatus | null {
  if (
    !isRecord(value) ||
    !nonBlankString(value.id) ||
    !nonBlankString(value.label) ||
    !isToolState(value.status)
  ) {
    return null
  }
  return { id: value.id, label: value.label, status: value.status }
}

function decodeApproval(value: unknown): ApprovalRequest | null {
  if (
    !isRecord(value) ||
    !nonBlankString(value.id) ||
    (value.kind !== "command" && value.kind !== "file_change") ||
    !nonBlankString(value.label)
  ) {
    return null
  }
  return { id: value.id, kind: value.kind, label: value.label }
}

function decodeError(
  value: Record<string, unknown>
): ConversationErrorEvent | null {
  if (!nonBlankString(value.code) || !nonBlankString(value.message)) return null
  if (value.terminal === false) {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      terminal: false,
    }
  }
  if (value.terminal !== true) return null
  if (value.scope === "turn" && nonBlankString(value.turnId)) {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      terminal: true,
      scope: "turn",
      turnId: value.turnId,
    }
  }
  if (value.scope === "session") {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      terminal: true,
      scope: "session",
    }
  }
  return null
}

function isToolState(value: unknown): value is ToolStatus["status"] {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "declined"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
