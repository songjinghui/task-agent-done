import type {
  ConversationEvent,
  ConversationEventEnvelope,
} from "../shared/contracts.js"

export type ConversationEventHandler = (
  event: ConversationEventEnvelope
) => void

export class EventHub {
  readonly #subscribers = new Set<ConversationEventHandler>()
  #nextSequence = 1

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  publish(conversationId: string, payload: ConversationEvent): void {
    const envelope = immutableSnapshot({
      conversationId,
      seq: this.#nextSequence++,
      payload,
    })

    for (const subscriber of this.#subscribers) {
      try {
        subscriber(envelope)
      } catch {
        // A broken client must not prevent delivery to the remaining clients.
      }
    }
  }

  subscribe(handler: ConversationEventHandler): () => void {
    this.#subscribers.add(handler)
    let subscribed = true

    return () => {
      if (!subscribed) return
      subscribed = false
      this.#subscribers.delete(handler)
    }
  }
}

function immutableSnapshot(
  envelope: ConversationEventEnvelope
): ConversationEventEnvelope {
  return deepFreeze(structuredClone(envelope))
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return value
  }

  visited.add(value)
  for (const child of Object.values(value)) {
    deepFreeze(child, visited)
  }
  return Object.freeze(value)
}
