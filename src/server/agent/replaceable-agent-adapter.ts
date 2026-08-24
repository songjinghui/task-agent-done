import type {
  ApprovalDecision,
  MessageTurn,
} from "../../shared/contracts.js"
import type { AgentAdapter, AgentAdapterEvent } from "./agent-adapter.js"

export class ReplaceableAgentAdapter implements AgentAdapter {
  readonly #listeners = new Set<(event: AgentAdapterEvent) => void>()
  #adapter: AgentAdapter = new UnavailableAgentAdapter("app_server_not_started")
  #unsubscribe: (() => void) | undefined
  #generation = 0

  replace(adapter: AgentAdapter): void {
    this.#generation += 1
    const generation = this.#generation
    this.#unsubscribe?.()
    this.#adapter.dispose?.()
    this.#adapter = adapter
    this.#unsubscribe = adapter.subscribe((event) => {
      if (generation !== this.#generation) return
      for (const listener of [...this.#listeners]) {
        try {
          listener(event)
        } catch {
          // One consumer must not interrupt the remaining event subscribers.
        }
      }
    })
  }

  makeUnavailable(code: string): void {
    this.replace(new UnavailableAgentAdapter(code))
  }

  dispose(): void {
    this.#generation += 1
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#adapter.dispose?.()
    this.#adapter = new UnavailableAgentAdapter("app_server_stopped")
  }

  createSession(workspace: string): Promise<{ externalSessionId: string }> {
    return this.#adapter.createSession(workspace)
  }
  readSession(externalSessionId: string): Promise<MessageTurn[]> {
    return this.#adapter.readSession(externalSessionId)
  }
  resumeSession(externalSessionId: string): Promise<void> {
    return this.#adapter.resumeSession(externalSessionId)
  }
  sendText(externalSessionId: string, text: string, operationId: string) {
    return this.#adapter.sendText(externalSessionId, text, operationId)
  }
  cancelTurn(externalSessionId: string): Promise<void> {
    return this.#adapter.cancelTurn(externalSessionId)
  }
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.#adapter.respondToApproval(requestId, decision)
  }
  subscribe(handler: (event: AgentAdapterEvent) => void): () => void {
    this.#listeners.add(handler)
    return () => this.#listeners.delete(handler)
  }
}

class UnavailableAgentAdapter implements AgentAdapter {
  constructor(readonly code: string) {}
  createSession(): Promise<{ externalSessionId: string }> {
    return Promise.reject(new Error(this.code))
  }
  readSession(): Promise<MessageTurn[]> {
    return Promise.reject(new Error(this.code))
  }
  resumeSession(): Promise<void> {
    return Promise.reject(new Error(this.code))
  }
  sendText(): Promise<{ turnId: string }> {
    return Promise.reject(new Error(this.code))
  }
  cancelTurn(): Promise<void> {
    return Promise.resolve()
  }
  respondToApproval(): Promise<void> {
    return Promise.reject(new Error(this.code))
  }
  subscribe(): () => void {
    return () => {}
  }
}
