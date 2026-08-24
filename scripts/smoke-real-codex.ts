import { realpathSync, statSync } from "node:fs"
import type { CodexJsonRpcClientEvent } from "../src/server/codex/codex-types.js"
import { CodexJsonRpcClient } from "../src/server/codex/json-rpc-client.js"

const PROMPT = "Reply with exactly TASKMUX_SMOKE_OK and do not use tools."
const EXPECTED = "TASKMUX_SMOKE_OK"
const TIMEOUT_MS = 60_000

const workspaceInput = process.env.TASKMUX_SMOKE_WORKSPACE
if (!workspaceInput) {
  throw new Error("TASKMUX_SMOKE_WORKSPACE is required")
}
if (process.env.TASKMUX_SMOKE_DISPOSABLE !== "YES") {
  throw new Error(
    "Refusing to run: set TASKMUX_SMOKE_DISPOSABLE=YES only for an explicitly disposable workspace."
  )
}

const workspace = realpathSync(workspaceInput)
if (!statSync(workspace).isDirectory()) {
  throw new Error("TASKMUX_SMOKE_WORKSPACE must be an existing directory")
}

const client = new CodexJsonRpcClient({
  command: "codex",
  args: ["app-server"],
  cwd: workspace,
})
const textByTurn = new Map<string, string>()
const completions = new Map<string, Deferred<string>>()
const forbiddenTool = deferred<never>()
void forbiddenTool.promise.catch(() => {})

const unsubscribe = client.subscribe((event) => {
  inspectEvent(event)
})

try {
  await client.start({ name: "taskmux-smoke", title: "TaskMux smoke", version: "0.0.0" })
  const thread = await client.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    serviceName: "taskmux-smoke",
  })
  const response = await client.request<{ turn: { id: string } }>("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: PROMPT, text_elements: [] }],
  })
  const turnId = response.turn.id
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Real Codex smoke timed out")),
      TIMEOUT_MS
    )
  })
  try {
    await Promise.race([completion(turnId).promise, forbiddenTool.promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }

  const output = (textByTurn.get(turnId) ?? "").trim()
  if (!output.includes(EXPECTED)) {
    throw new Error("Real Codex smoke returned unexpected text")
  }
  process.stdout.write("TaskMux real Codex smoke passed.\n")
} finally {
  unsubscribe()
  await client.stop()
}

function inspectEvent(event: CodexJsonRpcClientEvent): void {
  if (event.type === "server_request") {
    if (event.method.includes("requestApproval")) {
      try {
        client.respond(event.id, { decision: "decline" })
      } finally {
        forbiddenTool.reject(new Error("Real Codex smoke attempted to use a tool"))
      }
    }
    return
  }
  if (event.type !== "notification" || !isRecord(event.params)) return
  const turnId = stringField(event.params, "turnId")
  if (event.method === "item/started") {
    const item = isRecord(event.params.item) ? event.params.item : undefined
    if (item?.type === "commandExecution" || item?.type === "fileChange") {
      forbiddenTool.reject(new Error("Real Codex smoke attempted to use a tool"))
    }
    return
  }
  if (event.method === "item/agentMessage/delta" && turnId) {
    const delta = stringField(event.params, "delta")
    if (delta !== undefined) textByTurn.set(turnId, (textByTurn.get(turnId) ?? "") + delta)
    return
  }
  if (event.method !== "turn/completed") return
  const turn = isRecord(event.params.turn) ? event.params.turn : undefined
  const completedTurnId = turn && stringField(turn, "id")
  const status = turn && stringField(turn, "status")
  if (!completedTurnId) return
  if (status === "completed") completion(completedTurnId).resolve(completedTurnId)
  else completion(completedTurnId).reject(new Error("Real Codex smoke turn did not complete"))
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

function completion(turnId: string): Deferred<string> {
  const existing = completions.get(turnId)
  if (existing) return existing
  const created = deferred<string>()
  completions.set(turnId, created)
  return created
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined
}
