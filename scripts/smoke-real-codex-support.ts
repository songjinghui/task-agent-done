import type {
  CodexClientInfo,
  CodexJsonRpcClientEvent,
  JsonRpcId,
} from "../src/server/codex/codex-types.js"

const PROMPT = "Reply with exactly TASKMUX_SMOKE_OK and do not use tools."
const EXPECTED = "TASKMUX_SMOKE_OK"
const DEFAULT_TIMEOUT_MS = 60_000
const SAFE_ITEM_TYPES = new Set([
  "message",
  "userMessage",
  "agentMessage",
  "reasoning",
])
const SAFE_FAILURE_MESSAGES = new Set([
  "Real Codex smoke refused an interaction",
  "Real Codex smoke refused an item",
  "Real Codex smoke transport failed",
  "Real Codex smoke timed out",
  "Real Codex smoke turn did not complete",
  "Real Codex smoke returned unexpected text",
])

export interface SmokeClient {
  start(clientInfo: CodexClientInfo, timeoutMs: number): Promise<void>
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>
  respond(id: JsonRpcId, result: unknown): void
  subscribe(listener: (event: CodexJsonRpcClientEvent) => void): () => void
  stop(timeoutMs: number): Promise<void>
}

export function inspectSmokeSafetyEvent(
  event: CodexJsonRpcClientEvent,
  respond: (id: JsonRpcId, result: unknown) => void
): Error | null {
  if (event.type === "server_request") {
    try {
      respond(event.id, { decision: "decline" })
    } catch {
      // The interaction still fails closed if the transport cannot receive the decline.
    }
    return new Error("Real Codex smoke refused an interaction")
  }
  if (event.type === "exit" || event.type === "protocol_error") {
    return new Error("Real Codex smoke transport failed")
  }
  if (
    event.type !== "notification" ||
    (event.method !== "item/started" && event.method !== "item/completed")
  ) {
    return null
  }
  const params = isRecord(event.params) ? event.params : undefined
  const item = params && isRecord(params.item) ? params.item : undefined
  const type = item && stringField(item, "type")
  return type && SAFE_ITEM_TYPES.has(type)
    ? null
    : new Error("Real Codex smoke refused an item")
}

export async function runRealCodexSmoke(
  client: SmokeClient,
  workspace: string,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<string> {
  const deadline = createDeadline(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.now ?? Date.now
  )
  const textByTurn = new Map<string, string>()
  const completions = new Map<string, Deferred<void>>()
  const eventFailure = deferred<never>()
  void eventFailure.promise.catch(() => {})
  const unsubscribe = client.subscribe((event) => {
    const safetyFailure = inspectSmokeSafetyEvent(event, (id, result) =>
      client.respond(id, result)
    )
    if (safetyFailure) {
      eventFailure.reject(safetyFailure)
      return
    }
    inspectConversationEvent(event, textByTurn, completions)
  })

  let workflowFailed = false
  try {
    await Promise.race([
      client.start(
        { name: "taskmux-smoke", title: "TaskMux smoke", version: "0.0.0" },
        deadline.remaining()
      ),
      eventFailure.promise,
    ])
    const thread = await Promise.race([
      client.request<{ thread: { id: string } }>(
        "thread/start",
        { cwd: workspace, serviceName: "taskmux-smoke" },
        deadline.remaining()
      ),
      eventFailure.promise,
    ])
    const response = await Promise.race([
      client.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: thread.thread.id,
          input: [{ type: "text", text: PROMPT, text_elements: [] }],
        },
        deadline.remaining()
      ),
      eventFailure.promise,
    ])
    const turnId = response.turn.id
    const completion = completionFor(completions, turnId)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Real Codex smoke timed out")),
        deadline.remaining()
      )
    })
    try {
      await Promise.race([completion.promise, eventFailure.promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }

    const output = (textByTurn.get(turnId) ?? "").trim()
    if (!output.includes(EXPECTED)) {
      throw new Error("Real Codex smoke returned unexpected text")
    }
    return output
  } catch (error) {
    workflowFailed = true
    throw sanitizedSmokeFailure(error)
  } finally {
    unsubscribe()
    try {
      await client.stop(deadline.remainingOrZero())
    } catch {
      if (!workflowFailed) {
        throw new Error("Real Codex smoke cleanup failed")
      }
    }
  }
}

function sanitizedSmokeFailure(value: unknown): Error {
  if (value instanceof Error && SAFE_FAILURE_MESSAGES.has(value.message)) {
    return value
  }
  return new Error("Real Codex smoke failed")
}

function inspectConversationEvent(
  event: CodexJsonRpcClientEvent,
  textByTurn: Map<string, string>,
  completions: Map<string, Deferred<void>>
): void {
  if (event.type !== "notification" || !isRecord(event.params)) return
  const turnId = stringField(event.params, "turnId")
  if (event.method === "item/agentMessage/delta" && turnId) {
    const delta = stringField(event.params, "delta")
    if (delta !== undefined) {
      textByTurn.set(turnId, (textByTurn.get(turnId) ?? "") + delta)
    }
    return
  }
  if (event.method !== "turn/completed") return
  const turn = isRecord(event.params.turn) ? event.params.turn : undefined
  const completedTurnId = turn && stringField(turn, "id")
  const status = turn && stringField(turn, "status")
  if (!completedTurnId) return
  const completion = completionFor(completions, completedTurnId)
  if (status === "completed") completion.resolve()
  else completion.reject(new Error("Real Codex smoke turn did not complete"))
}

function createDeadline(timeoutMs: number, now: () => number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_smoke_timeout")
  }
  const expiresAt = now() + timeoutMs
  return {
    remaining(): number {
      const remaining = expiresAt - now()
      if (remaining <= 0) throw new Error("Real Codex smoke timed out")
      return remaining
    },
    remainingOrZero(): number {
      return Math.max(0, expiresAt - now())
    },
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function completionFor(
  completions: Map<string, Deferred<void>>,
  turnId: string
): Deferred<void> {
  const existing = completions.get(turnId)
  if (existing) return existing
  const created = deferred<void>()
  void created.promise.catch(() => {})
  completions.set(turnId, created)
  return created
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined
}
