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
  #replacementWait: Promise<void> | undefined
  #replacementReady: (() => void) | undefined

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
    this.#settleReplacement()
  }

  beginReplacement(code: string): void {
    this.replace(new UnavailableAgentAdapter(code))
    this.#replacementWait = new Promise((resolve) => {
      this.#replacementReady = resolve
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
    this.#settleReplacement()
  }

  async createSession(workspace: string): Promise<{ externalSessionId: string }> {
    return (await this.#readyAdapter()).createSession(workspace)
  }
  async readSession(externalSessionId: string): Promise<MessageTurn[]> {
    return (await this.#readyAdapter()).readSession(externalSessionId)
  }
  async resumeSession(externalSessionId: string): Promise<void> {
    return (await this.#readyAdapter()).resumeSession(externalSessionId)
  }
  async sendText(externalSessionId: string, text: string, operationId: string) {
    return (await this.#readyAdapter()).sendText(
      externalSessionId,
      text,
      operationId
    )
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

  #settleReplacement(): void {
    this.#replacementReady?.()
    this.#replacementReady = undefined
    this.#replacementWait = undefined
  }

  async #readyAdapter(): Promise<AgentAdapter> {
    while (this.#replacementWait) await this.#replacementWait
    return this.#adapter
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
