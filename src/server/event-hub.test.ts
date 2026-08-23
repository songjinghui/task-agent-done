import { describe, expect, it } from "vitest"
import type {
  ConversationEvent,
  ConversationEventEnvelope,
} from "../shared/contracts.js"
import { EventHub } from "./event-hub.js"

describe("EventHub", () => {
  it("uses one monotonic sequence across conversations", () => {
    const hub = new EventHub()
    const received: ConversationEventEnvelope[] = []
    hub.subscribe((event) => received.push(event))

    hub.publish("c1", { type: "turn_started", turnId: "t1" })
    hub.publish("c2", {
      type: "text_delta",
      turnId: "t2",
      text: "hello",
    })

    expect(received.map((event) => event.seq)).toEqual([1, 2])
    expect(received.map((event) => event.conversationId)).toEqual(["c1", "c2"])
  })

  it("publishes an immutable snapshot instead of retaining caller-owned data", () => {
    const hub = new EventHub()
    const received: ConversationEventEnvelope[] = []
    const payload: ConversationEvent = {
      type: "tool_status",
      tool: { id: "tool-1", label: "运行命令", status: "running" },
    }
    hub.subscribe((event) => received.push(event))

    hub.publish("c1", payload)
    payload.tool.status = "failed"

    expect(received[0]).toEqual({
      conversationId: "c1",
      seq: 1,
      payload: {
        type: "tool_status",
        tool: { id: "tool-1", label: "运行命令", status: "running" },
      },
    })
    const event = received[0]
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event?.payload)).toBe(true)
    if (event?.payload.type !== "tool_status") {
      throw new Error("Expected a tool status event")
    }
    expect(Object.isFrozen(event.payload.tool)).toBe(true)
  })

  it("publishes only immutable browser-safe client request metadata", () => {
    const hub = new EventHub()
    const received: ConversationEventEnvelope[] = []
    const metadata = {
      clientRequestId: "client-safe-1",
      operationId: "provider-secret",
    }
    hub.subscribe((event) => received.push(event))

    hub.publish(
      "c1",
      { type: "approval_requested", request: { id: "a1", kind: "command", label: "run" } },
      metadata
    )
    metadata.clientRequestId = "mutated"

    expect(received).toEqual([
      {
        conversationId: "c1",
        clientRequestId: "client-safe-1",
        seq: 1,
        payload: {
          type: "approval_requested",
          request: { id: "a1", kind: "command", label: "run" },
        },
      },
    ])
    expect(JSON.stringify(received)).not.toContain("operationId")
    expect(Object.isFrozen(received[0])).toBe(true)
  })

  it("isolates listener failures and keeps delivering to other subscribers", () => {
    const hub = new EventHub()
    const received: ConversationEventEnvelope[] = []
    hub.subscribe(() => {
      throw new Error("broken listener")
    })
    hub.subscribe((event) => received.push(event))

    expect(() =>
      hub.publish("c1", { type: "turn_started", turnId: "t1" })
    ).not.toThrow()
    expect(received).toHaveLength(1)
  })

  it("returns an idempotent unsubscribe and reports the subscriber count", () => {
    const hub = new EventHub()
    const received: ConversationEventEnvelope[] = []
    const unsubscribe = hub.subscribe((event) => received.push(event))

    expect(hub.subscriberCount).toBe(1)
    unsubscribe()
    unsubscribe()
    expect(hub.subscriberCount).toBe(0)

    hub.publish("c1", { type: "turn_started", turnId: "t1" })
    expect(received).toEqual([])
  })
})
