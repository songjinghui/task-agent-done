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
  turnKey: string
}

type BufferedTurnEvent = {
  payload: AgentAdapterEvent["payload"]
  approval?: {
    requestId: string
    pending: PendingApproval
  }
}

type AdapterActiveTurn = {
  operationId: string
  turnId: string
}

type RunningTool = {
  id: string
  label: string
}

const COMMAND_LABEL = "运行命令"
const FILE_CHANGE_LABEL = "修改文件"
const GENERIC_TOOL_LABEL = "使用工具"
const NON_TOOL_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "hookPrompt",
  "plan",
  "reasoning",
  "userMessage",
])

export class CodexAppServerAdapter implements AgentAdapter {
  readonly #client: CodexJsonRpcClient
  readonly #unsubscribeClient: () => void
  readonly #listeners = new Set<(event: AgentAdapterEvent) => void>()
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  readonly #activeTurns = new Map<string, AdapterActiveTurn>()
  readonly #interruptsRequested = new Map<string, AdapterActiveTurn>()
  readonly #latestStartOperations = new Map<string, string>()
  readonly #pendingStartOperations = new Map<string, Set<string>>()
  readonly #turnOperations = new Map<string, string>()
  readonly #bufferedTurnEvents = new Map<string, BufferedTurnEvent[]>()
  readonly #runningTools = new Map<string, Map<string, RunningTool>>()
  #nextApprovalId = 1

  constructor(client: CodexJsonRpcClient) {
    this.#client = client
    this.#unsubscribeClient = this.#client.subscribe((event) =>
      this.#handleClientEvent(event)
    )
  }

  dispose(): void {
    this.#unsubscribeClient()
  }

  async createSession(workspace: string): Promise<{ externalSessionId: string }> {
    const response = await this.#client.request<CodexThreadResponse>("thread/start", {
      cwd: workspace,
      serviceName: "taskmux",
    })
    return { externalSessionId: requireThread(response).id }
  }

  async readSession(externalSessionId: string): Promise<MessageTurn[]> {
    try {
      const response = await this.#client.request<CodexThreadResponse>(
        "thread/read",
        { threadId: externalSessionId, includeTurns: true }
      )
      return projectHistory(requireThread(response))
    } catch {
      // Codex 0.147.0 rejects includeTurns before the first user message
      // ("thread is not materialized yet"). A fresh thread has no history, so
      // confirm the thread still exists and report empty history.
      const response = await this.#client.request<CodexThreadResponse>(
        "thread/read",
        { threadId: externalSessionId }
      )
      requireThread(response)
      return []
    }
  }

  async resumeSession(_externalSessionId: string): Promise<void> {
    // Codex 0.147.0 starts a thread ready for direct input; turn/start accepts
    // a threadId directly, so there is no separate resume step to perform.
  }

  async sendText(
    externalSessionId: string,
    text: string,
    operationId: string
  ): Promise<{ turnId: string }> {
    this.#latestStartOperations.set(externalSessionId, operationId)
    const pending = this.#pendingStartOperations.get(externalSessionId) ?? new Set()
    pending.add(operationId)
    this.#pendingStartOperations.set(externalSessionId, pending)

    try {
      const response = await this.#client.request<CodexTurnResponse>("turn/start", {
        threadId: externalSessionId,
        input: [{ type: "text", text, text_elements: [] }],
      })
      const turn = requireTurn(response)
      if (!this.#pendingStartOperations.get(externalSessionId)?.has(operationId)) {
        return { turnId: turn.id }
      }

      const key = turnKey(externalSessionId, turn.id)
      this.#turnOperations.set(key, operationId)
      const buffered = this.#bufferedTurnEvents.get(key) ?? []
      const alreadyTerminal = buffered.some(({ payload }) =>
        isTurnTerminalPayload(payload)
      )
      if (
        this.#latestStartOperations.get(externalSessionId) === operationId &&
        !alreadyTerminal
      ) {
        this.#setActiveTurn(externalSessionId, { operationId, turnId: turn.id })
      }
      this.#settleStartOperation(externalSessionId, operationId)
      this.#bufferedTurnEvents.delete(key)
      let terminalDelivered = false
      for (const bufferedEvent of buffered) {
        if (terminalDelivered) {
          this.#declineBufferedApproval(bufferedEvent)
          continue
        }
        this.#deliverTurnEvent(
          externalSessionId,
          turn.id,
          operationId,
          bufferedEvent
        )
        terminalDelivered = isTurnTerminalPayload(bufferedEvent.payload)
      }
      this.#discardOrphanedBuffers(externalSessionId)
      return { turnId: turn.id }
    } catch (error) {
      this.#settleStartOperation(externalSessionId, operationId)
      if (this.#latestStartOperations.get(externalSessionId) === operationId) {
        this.#latestStartOperations.delete(externalSessionId)
      }
      this.#discardOrphanedBuffers(externalSessionId)
      throw error
    }
  }

  async cancelTurn(externalSessionId: string): Promise<void> {
    const activeTurn = this.#activeTurns.get(externalSessionId)
    if (
      !activeTurn ||
      this.#interruptsRequested.get(externalSessionId) === activeTurn
    ) {
      return
    }

    this.#interruptsRequested.set(externalSessionId, activeTurn)
    try {
      await this.#client.request("turn/interrupt", {
        threadId: externalSessionId,
        turnId: activeTurn.turnId,
      })
    } catch (error) {
      if (this.#interruptsRequested.get(externalSessionId) === activeTurn) {
        this.#interruptsRequested.delete(externalSessionId)
      }
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
        this.#emitTurnEvent(threadId, turnId, {
          type: "text_delta",
          turnId,
          text,
        })
      }
      return
    }

    if (method === "turn/started") {
      const turn = recordField(params, "turn")
      const turnId = turn && stringField(turn, "id")
      if (turnId) {
        this.#emitTurnEvent(threadId, turnId, { type: "turn_started", turnId })
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

    this.#emitTurnEvent(threadId, turnId, { type: "tool_status", tool })
  }

  #handleTurnCompleted(threadId: string, params: Record<string, unknown>): void {
    const turn = recordField(params, "turn")
    const turnId = turn && stringField(turn, "id")
    const status = turn && stringField(turn, "status")
    if (!turnId) return

    if (status === "interrupted") {
      this.#emitTurnEvent(threadId, turnId, { type: "turn_interrupted", turnId })
      return
    }
    if (status === "completed") {
      this.#emitTurnEvent(threadId, turnId, { type: "turn_completed", turnId })
      return
    }
    const failure = status === "failed" ? failedTurnError(turn) : undefined
    this.#emitTurnEvent(threadId, turnId, {
      type: "error",
      code: failure?.code ?? "unsupported_turn_status",
      message: failure?.message ?? "Agent turn ended with an unsupported status.",
      terminal: true,
      scope: "turn",
      turnId,
    })
  }

  #handleTransportFailure(code: string, message: string): void {
    const affectedSessions = new Set([
      ...this.#activeTurns.keys(),
      ...this.#pendingStartOperations.keys(),
    ])
    const approvalRequestIds = new Set<JsonRpcId>()
    for (const pending of this.#pendingApprovals.values()) {
      approvalRequestIds.add(pending.serverRequestId)
    }
    for (const events of this.#bufferedTurnEvents.values()) {
      for (const event of events) {
        if (event.approval) {
          approvalRequestIds.add(event.approval.pending.serverRequestId)
        }
      }
    }
    const runningToolEvents: Array<{
      externalSessionId: string
      operationId: string
      tool: RunningTool
    }> = []
    for (const [key, tools] of this.#runningTools) {
      const operationId = this.#turnOperations.get(key)
      const separator = key.indexOf("\u0000")
      if (operationId === undefined || separator === -1) continue
      const externalSessionId = key.slice(0, separator)
      for (const tool of tools.values()) {
        runningToolEvents.push({ externalSessionId, operationId, tool })
      }
    }
    this.#activeTurns.clear()
    this.#interruptsRequested.clear()
    this.#latestStartOperations.clear()
    this.#pendingStartOperations.clear()
    this.#turnOperations.clear()
    this.#bufferedTurnEvents.clear()
    this.#runningTools.clear()
    this.#pendingApprovals.clear()

    for (const requestId of approvalRequestIds) {
      this.#declineServerRequest(requestId)
    }
    for (const { externalSessionId, operationId, tool } of runningToolEvents) {
      this.#emit(
        externalSessionId,
        { type: "tool_status", tool: { ...tool, status: "failed" } },
        operationId
      )
    }

    for (const externalSessionId of affectedSessions) {
      this.#emit(externalSessionId, {
        type: "error",
        code,
        message,
        terminal: true,
        scope: "session",
      })
    }
  }

  #handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const threadId = isRecord(params) ? stringField(params, "threadId") : undefined
    const turnId = isRecord(params) ? stringField(params, "turnId") : undefined
    const approval = approvalForMethod(method)
    if (!approval || !threadId || !turnId) {
      this.#client.respond(id, { decision: "decline" })
      this.#emit(threadId ?? "", {
        type: "error",
        code: "unsupported_interaction",
        message: "Agent requested an unsupported interaction.",
        terminal: false,
      })
      return
    }

    const key = turnKey(threadId, turnId)
    if (
      !this.#turnOperations.has(key) &&
      !this.#pendingStartOperations.get(threadId)?.size
    ) {
      this.#client.respond(id, { decision: "decline" })
      return
    }

    const requestId = `approval_${this.#nextApprovalId++}`
    this.#emitTurnEvent(
      threadId,
      turnId,
      {
        type: "approval_requested",
        request: { id: requestId, kind: approval.kind, label: approval.label },
      },
      { requestId, pending: { serverRequestId: id, turnKey: key } }
    )
  }

  #emitTurnEvent(
    externalSessionId: string,
    turnId: string,
    payload: AgentAdapterEvent["payload"],
    approval?: BufferedTurnEvent["approval"]
  ): void {
    const key = turnKey(externalSessionId, turnId)
    const operationId = this.#turnOperations.get(key)
    if (operationId === undefined) {
      if (this.#pendingStartOperations.get(externalSessionId)?.size) {
        const buffered = this.#bufferedTurnEvents.get(key) ?? []
        buffered.push({ payload, approval })
        this.#bufferedTurnEvents.set(key, buffered)
      }
      return
    }
    this.#deliverTurnEvent(externalSessionId, turnId, operationId, {
      payload,
      approval,
    })
  }

  #deliverTurnEvent(
    externalSessionId: string,
    turnId: string,
    operationId: string,
    bufferedEvent: BufferedTurnEvent
  ): void {
    const { payload, approval } = bufferedEvent
    if (approval) {
      this.#pendingApprovals.set(approval.requestId, approval.pending)
    }
    if (payload.type === "tool_status") {
      this.#recordToolStatus(externalSessionId, turnId, payload.tool)
    }
    if (
      payload.type === "turn_started" &&
      this.#latestStartOperations.get(externalSessionId) === operationId
    ) {
      this.#setActiveTurn(externalSessionId, { operationId, turnId })
    }
    if (isTurnTerminalPayload(payload)) {
      this.#finishRunningTools(externalSessionId, turnId, operationId, payload)
    }
    this.#emit(externalSessionId, payload, operationId)
    if (isTurnTerminalPayload(payload)) {
      this.#retireTurn(externalSessionId, turnId, operationId)
    }
  }

  #setActiveTurn(externalSessionId: string, activeTurn: AdapterActiveTurn): void {
    const current = this.#activeTurns.get(externalSessionId)
    if (
      current?.operationId === activeTurn.operationId &&
      current.turnId === activeTurn.turnId
    ) {
      return
    }
    this.#activeTurns.set(externalSessionId, activeTurn)
    if (this.#interruptsRequested.get(externalSessionId) !== activeTurn) {
      this.#interruptsRequested.delete(externalSessionId)
    }
  }

  #retireTurn(
    externalSessionId: string,
    turnId: string,
    operationId: string
  ): void {
    const activeTurn = this.#activeTurns.get(externalSessionId)
    if (
      activeTurn?.operationId === operationId &&
      activeTurn.turnId === turnId
    ) {
      this.#activeTurns.delete(externalSessionId)
      if (this.#interruptsRequested.get(externalSessionId) === activeTurn) {
        this.#interruptsRequested.delete(externalSessionId)
      }
    }
    const key = turnKey(externalSessionId, turnId)
    this.#turnOperations.delete(key)
    this.#discardTurnBookkeeping(key)
    if (this.#latestStartOperations.get(externalSessionId) === operationId) {
      this.#latestStartOperations.delete(externalSessionId)
    }
  }

  #settleStartOperation(externalSessionId: string, operationId: string): void {
    const pending = this.#pendingStartOperations.get(externalSessionId)
    pending?.delete(operationId)
    if (pending?.size === 0) this.#pendingStartOperations.delete(externalSessionId)
  }

  #discardOrphanedBuffers(externalSessionId: string): void {
    if (this.#pendingStartOperations.has(externalSessionId)) return
    const prefix = `${externalSessionId}\u0000`
    for (const key of this.#bufferedTurnEvents.keys()) {
      if (key.startsWith(prefix) && !this.#turnOperations.has(key)) {
        this.#discardTurnBookkeeping(key)
      }
    }
  }

  #discardTurnBookkeeping(key: string): void {
    const buffered = this.#bufferedTurnEvents.get(key) ?? []
    this.#bufferedTurnEvents.delete(key)
    for (const bufferedEvent of buffered) {
      this.#declineBufferedApproval(bufferedEvent)
    }
    this.#runningTools.delete(key)
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.turnKey === key) {
        this.#pendingApprovals.delete(requestId)
        this.#declineServerRequest(pending.serverRequestId)
      }
    }
  }

  #declineBufferedApproval(bufferedEvent: BufferedTurnEvent): void {
    if (bufferedEvent.approval) {
      this.#declineServerRequest(bufferedEvent.approval.pending.serverRequestId)
    }
  }

  #declineServerRequest(serverRequestId: JsonRpcId): void {
    try {
      this.#client.respond(serverRequestId, { decision: "decline" })
    } catch {
      // The transport may already be gone; bookkeeping is still retired locally.
    }
  }

  #recordToolStatus(
    externalSessionId: string,
    turnId: string,
    tool: ToolStatus
  ): void {
    const key = turnKey(externalSessionId, turnId)
    if (tool.status === "running") {
      const tools = this.#runningTools.get(key) ?? new Map<string, RunningTool>()
      tools.set(tool.id, { id: tool.id, label: tool.label })
      this.#runningTools.set(key, tools)
      return
    }
    const tools = this.#runningTools.get(key)
    tools?.delete(tool.id)
    if (tools?.size === 0) this.#runningTools.delete(key)
  }

  #finishRunningTools(
    externalSessionId: string,
    turnId: string,
    operationId: string,
    terminalPayload: AgentAdapterEvent["payload"]
  ): void {
    const key = turnKey(externalSessionId, turnId)
    const tools = this.#runningTools.get(key)
    if (!tools) return
    const terminalToolStatus =
      terminalPayload.type === "turn_interrupted" ? "declined" : "failed"
    for (const tool of tools.values()) {
      this.#emit(
        externalSessionId,
        {
          type: "tool_status",
          tool: { ...tool, status: terminalToolStatus },
        },
        operationId
      )
    }
    this.#runningTools.delete(key)
  }

  #emit(
    externalSessionId: string,
    payload: AgentAdapterEvent["payload"],
    operationId?: string
  ): void {
    const event =
      operationId === undefined
        ? { externalSessionId, payload }
        : { externalSessionId, operationId, payload }
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
  const type = stringField(item, "type")
  if (!id || !type || NON_TOOL_ITEM_TYPES.has(type)) return undefined
  const label =
    type === "commandExecution"
      ? COMMAND_LABEL
      : type === "fileChange"
        ? FILE_CHANGE_LABEL
        : GENERIC_TOOL_LABEL

  return {
    id,
    label,
    status: started ? "running" : normalizeCompletedToolStatus(item.status),
  }
}

function normalizeCompletedToolStatus(status: unknown): ToolStatus["status"] {
  if (status === "completed" || status === "failed" || status === "declined") {
    return status
  }
  return "completed"
}

function failedTurnError(turn: Record<string, unknown>): {
  code: string
  message: string
} {
  const error = recordField(turn, "error")
  return {
    code: nonBlankStringField(error, "codexErrorInfo") ?? "turn_failed",
    message: nonBlankStringField(error, "message") ?? "Agent turn failed.",
  }
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

function isTurnTerminalPayload(payload: AgentAdapterEvent["payload"]): boolean {
  return (
    payload.type === "turn_completed" ||
    payload.type === "turn_interrupted" ||
    (payload.type === "error" && payload.terminal && payload.scope === "turn")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function nonBlankStringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!record) return undefined
  const value = stringField(record, key)
  return value?.trim() ? value : undefined
}

function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
