import type {
  ApprovalDecision,
  MessageTurn,
  ToolStatus,
} from "../../shared/contracts.js"
import type { AgentAdapter, AgentAdapterEvent } from "../agent/agent-adapter.js"
import type {
  CodexJsonRpcClient,
  CodexJsonRpcClientEvent,
  JsonRpcId,
} from "./json-rpc-client.js"

type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress"
type CodexToolStatus = "inProgress" | "completed" | "failed" | "declined"

type CodexTextInput = {
  type: "text"
  text: string
}

type CodexUserMessageItem = {
  type: "userMessage"
  id: string
  content: CodexTextInput[]
}

type CodexAgentMessageItem = {
  type: "agentMessage"
  id: string
  text: string
}

type CodexCommandItem = {
  type: "commandExecution"
  id: string
  status: CodexToolStatus
}

type CodexFileChangeItem = {
  type: "fileChange"
  id: string
  status: CodexToolStatus
}

type CodexItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexCommandItem
  | CodexFileChangeItem
  | { type: string; id?: string }

type CodexTurn = {
  id: string
  items: CodexItem[]
  status: CodexTurnStatus
}

type CodexThread = {
  id: string
  turns: CodexTurn[]
}

type CodexThreadResponse = {
  thread: CodexThread
}

type CodexTurnResponse = {
  turn: CodexTurn
}

type PendingApproval = {
  serverRequestId: JsonRpcId
}

type RunningTool = {
  id: string
  label: string
}

const COMMAND_LABEL = "运行命令"
const FILE_CHANGE_LABEL = "修改文件"

export class CodexAppServerAdapter implements AgentAdapter {
  readonly #client: CodexJsonRpcClient
  readonly #listeners = new Set<(event: AgentAdapterEvent) => void>()
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  readonly #activeTurns = new Map<string, string>()
  readonly #interruptsRequested = new Set<string>()
  readonly #runningTools = new Map<string, Map<string, RunningTool>>()
  #nextApprovalId = 1

  constructor(client: CodexJsonRpcClient) {
    this.#client = client
    this.#client.subscribe((event) => this.#handleClientEvent(event))
  }

  async createSession(workspace: string): Promise<{ externalSessionId: string }> {
    const response = await this.#client.request<CodexThreadResponse>("thread/start", {
      cwd: workspace,
      serviceName: "taskmux",
    })
    return { externalSessionId: requireThread(response).id }
  }

  async readSession(externalSessionId: string): Promise<MessageTurn[]> {
    const response = await this.#client.request<CodexThreadResponse>("thread/read", {
      threadId: externalSessionId,
      includeTurns: true,
    })
    return projectHistory(requireThread(response))
  }

  async resumeSession(externalSessionId: string): Promise<void> {
    await this.#client.request("thread/resume", { threadId: externalSessionId })
  }

  async sendText(externalSessionId: string, text: string): Promise<void> {
    const response = await this.#client.request<CodexTurnResponse>("turn/start", {
      threadId: externalSessionId,
      input: [{ type: "text", text, text_elements: [] }],
    })
    const turn = requireTurn(response)
    this.#activeTurns.set(externalSessionId, turn.id)
    this.#interruptsRequested.delete(externalSessionId)
  }

  async cancelTurn(externalSessionId: string): Promise<void> {
    const turnId = this.#activeTurns.get(externalSessionId)
    if (!turnId || this.#interruptsRequested.has(externalSessionId)) return

    this.#interruptsRequested.add(externalSessionId)
    try {
      await this.#client.request("turn/interrupt", {
        threadId: externalSessionId,
        turnId,
      })
    } catch (error) {
      this.#interruptsRequested.delete(externalSessionId)
      throw error
    }
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) throw new Error("approval_expired")

    this.#pendingApprovals.delete(requestId)
    this.#client.respond(pending.serverRequestId, { decision })
  }

  subscribe(handler: (event: AgentAdapterEvent) => void): () => void {
    this.#listeners.add(handler)
    return () => this.#listeners.delete(handler)
  }

  #handleClientEvent(event: CodexJsonRpcClientEvent): void {
    if (event.type === "notification") {
      this.#handleNotification(event.method, event.params)
      return
    }
    if (event.type === "server_request") {
      this.#handleServerRequest(event.id, event.method, event.params)
      return
    }
    if (event.type === "exit") {
      this.#handleTransportFailure(
        "app_server_exited",
        "Agent server exited unexpectedly."
      )
      return
    }
    if (event.type === "protocol_error") {
      this.#handleTransportFailure(
        "app_server_protocol_error",
        "Agent server protocol error."
      )
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return
    const threadId = stringField(params, "threadId")
    if (!threadId) return

    if (method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId")
      const text = stringField(params, "delta")
      if (turnId !== undefined && text !== undefined) {
        this.#emit(threadId, { type: "text_delta", turnId, text })
      }
      return
    }

    if (method === "turn/started") {
      const turn = recordField(params, "turn")
      const turnId = turn && stringField(turn, "id")
      if (turnId) {
        this.#activeTurns.set(threadId, turnId)
        this.#interruptsRequested.delete(threadId)
        this.#emit(threadId, { type: "turn_started", turnId })
      }
      return
    }

    if (method === "turn/completed") {
      this.#handleTurnCompleted(threadId, params)
      return
    }

    if (method === "item/started" || method === "item/completed") {
      this.#handleToolNotification(threadId, params, method === "item/started")
    }
  }

  #handleToolNotification(
    threadId: string,
    params: Record<string, unknown>,
    started: boolean
  ): void {
    const turnId = stringField(params, "turnId")
    const item = recordField(params, "item")
    if (!turnId || !item) return

    const tool = normalizeTool(item, started)
    if (!tool) return

    const key = turnKey(threadId, turnId)
    if (tool.status === "running") {
      const tools = this.#runningTools.get(key) ?? new Map<string, RunningTool>()
      tools.set(tool.id, { id: tool.id, label: tool.label })
      this.#runningTools.set(key, tools)
    } else {
      const tools = this.#runningTools.get(key)
      tools?.delete(tool.id)
      if (tools?.size === 0) this.#runningTools.delete(key)
    }
    this.#emit(threadId, { type: "tool_status", tool })
  }

  #handleTurnCompleted(threadId: string, params: Record<string, unknown>): void {
    const turn = recordField(params, "turn")
    const turnId = turn && stringField(turn, "id")
    const status = turn && stringField(turn, "status")
    if (!turnId) return

    const tools = this.#runningTools.get(turnKey(threadId, turnId))
    if (tools) {
      const terminalToolStatus = status === "interrupted" ? "declined" : "failed"
      for (const tool of tools.values()) {
        this.#emit(threadId, {
          type: "tool_status",
          tool: { ...tool, status: terminalToolStatus },
        })
      }
      this.#runningTools.delete(turnKey(threadId, turnId))
    }

    if (this.#activeTurns.get(threadId) === turnId) {
      this.#activeTurns.delete(threadId)
      this.#interruptsRequested.delete(threadId)
    }

    if (status === "interrupted") {
      this.#emit(threadId, { type: "turn_interrupted", turnId })
      return
    }
    if (status === "completed") {
      this.#emit(threadId, { type: "turn_completed", turnId })
      return
    }
    this.#emit(threadId, {
      type: "error",
      code: status === "failed" ? "turn_failed" : "unsupported_turn_status",
      message:
        status === "failed"
          ? "Agent turn failed."
          : "Agent turn ended with an unsupported status.",
    })
  }

  #handleTransportFailure(code: string, message: string): void {
    const affectedSessions = [...this.#activeTurns.keys()]
    this.#activeTurns.clear()
    this.#interruptsRequested.clear()
    this.#runningTools.clear()
    this.#pendingApprovals.clear()

    for (const externalSessionId of affectedSessions) {
      this.#emit(externalSessionId, { type: "error", code, message })
    }
  }

  #handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const threadId = isRecord(params) ? stringField(params, "threadId") : undefined
    const approval = approvalForMethod(method)
    if (!approval || !threadId) {
      this.#client.respond(id, { decision: "decline" })
      this.#emit(threadId ?? "", {
        type: "error",
        code: "unsupported_interaction",
        message: "Agent requested an unsupported interaction.",
      })
      return
    }

    const requestId = `approval_${this.#nextApprovalId++}`
    this.#pendingApprovals.set(requestId, { serverRequestId: id })
    this.#emit(threadId, {
      type: "approval_requested",
      request: { id: requestId, kind: approval.kind, label: approval.label },
    })
  }

  #emit(externalSessionId: string, payload: AgentAdapterEvent["payload"]): void {
    const event = { externalSessionId, payload }
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A consumer must not interrupt the App Server event stream.
      }
    }
  }
}

function requireThread(response: unknown): CodexThread {
  if (!isRecord(response) || !isRecord(response.thread)) {
    throw new Error("invalid_thread_response")
  }
  const id = stringField(response.thread, "id")
  if (!id) throw new Error("invalid_thread_response")
  return response.thread as CodexThread
}

function requireTurn(response: unknown): CodexTurn {
  if (!isRecord(response) || !isRecord(response.turn)) {
    throw new Error("invalid_turn_response")
  }
  const id = stringField(response.turn, "id")
  if (!id) throw new Error("invalid_turn_response")
  return response.turn as CodexTurn
}

function projectHistory(thread: CodexThread): MessageTurn[] {
  if (!Array.isArray(thread.turns)) return []
  const messages: MessageTurn[] = []
  for (const value of thread.turns) {
    if (!isRecord(value) || !Array.isArray(value.items)) continue
    const status = historyStatus(value.status)
    for (const item of value.items) {
      if (isCodexAgentMessageItem(item)) {
        messages.push({ id: item.id, role: "assistant", text: item.text, status })
      }
      if (isCodexUserMessageItem(item)) {
        const text = item.content
          .filter(isRecord)
          .filter((input) => input.type === "text" && typeof input.text === "string")
          .map((input) => input.text as string)
          .join("")
        messages.push({ id: item.id, role: "user", text, status })
      }
    }
  }
  return messages
}

function historyStatus(status: unknown): MessageTurn["status"] {
  if (status === "completed" || status === "failed" || status === "interrupted") {
    return status
  }
  return "interrupted"
}

function normalizeTool(item: Record<string, unknown>, started: boolean): ToolStatus | undefined {
  const id = stringField(item, "id")
  if (!id) return undefined
  const label =
    item.type === "commandExecution"
      ? COMMAND_LABEL
      : item.type === "fileChange"
        ? FILE_CHANGE_LABEL
        : undefined
  if (!label) return undefined

  return {
    id,
    label,
    status: started ? "running" : normalizeToolStatus(item.status),
  }
}

function normalizeToolStatus(status: unknown): ToolStatus["status"] {
  if (status === "completed" || status === "failed" || status === "declined") {
    return status
  }
  return "running"
}

function isCodexAgentMessageItem(value: CodexItem): value is CodexAgentMessageItem {
  return (
    value.type === "agentMessage" &&
    typeof (value as CodexAgentMessageItem).text === "string"
  )
}

function isCodexUserMessageItem(value: CodexItem): value is CodexUserMessageItem {
  return value.type === "userMessage" && Array.isArray((value as CodexUserMessageItem).content)
}

function approvalForMethod(
  method: string
): { kind: "command" | "file_change"; label: string } | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return { kind: "command", label: COMMAND_LABEL }
  }
  if (method === "item/fileChange/requestApproval") {
    return { kind: "file_change", label: FILE_CHANGE_LABEL }
  }
  return undefined
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
