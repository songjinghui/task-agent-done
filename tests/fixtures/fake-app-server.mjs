import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import readline from "node:readline"

let initialized = false
const statePath = join(process.cwd(), ".taskmux-fake-history.json")
const state = loadState()
const turns = new Map()
const approvalRequests = new Map()
let splitOutput = false
const queuedOutput = []

function loadState() {
  if (!existsSync(statePath)) return { nextThread: 1, nextTurn: 1, threads: {} }
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"))
    if (value && typeof value === "object" && value.threads) return value
  } catch {
    // A corrupt fixture state behaves like an empty isolated workspace.
  }
  return { nextThread: 1, nextTurn: 1, threads: {} }
}

function saveState() {
  writeFileSync(statePath, JSON.stringify(state))
}

function send(message) {
  const serialized = `${JSON.stringify(message)}\n`
  if (splitOutput) {
    queuedOutput.push(serialized)
    return
  }
  process.stdout.write(serialized)
}

function sendSplit(message) {
  const serialized = `${JSON.stringify(message)}\n`
  const middle = Math.ceil(serialized.length / 2)
  splitOutput = true
  process.stdout.write(serialized.slice(0, middle))
  setTimeout(() => {
    process.stdout.write(serialized.slice(middle))
    splitOutput = false
    for (const queued of queuedOutput.splice(0)) process.stdout.write(queued)
  }, 0)
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function reject(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32002, message } })
}

function notification(method, params) {
  send({ jsonrpc: "2.0", method, params })
}

function promptFrom(params) {
  if (typeof params?.prompt === "string") return params.prompt
  if (typeof params?.text === "string") return params.text
  if (typeof params?.input === "string") return params.input
  if (typeof params?.input?.[0]?.text === "string") return params.input[0].text
  return ""
}

function completeTurn(turn, { status = "completed", text = "ok", tools = [] } = {}) {
  if (turn.completed) return
  turn.completed = true
  const thread = state.threads[turn.threadId]
  if (thread) {
    thread.turns.push({
      id: turn.id,
      status,
      items: [
        {
          id: `user_${turn.id}`,
          type: "userMessage",
          content: [{ type: "text", text: turn.prompt }],
        },
        ...tools,
        ...(text
          ? [{ id: `assistant_${turn.id}`, type: "agentMessage", text }]
          : []),
      ],
    })
    saveState()
  }
  notification("turn/completed", {
    threadId: turn.threadId,
    turn: { id: turn.id, status },
  })
}

function requestApproval(turn, method) {
  const id = `approval_${turn.id}`
  approvalRequests.set(id, turn)
  send({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: `${method.includes("fileChange") ? "file" : "command"}_${turn.id}`,
    },
  })
}

function driveTurn(turn) {
  if (turn.prompt.includes("[crash-stderr]")) {
    spawn(
      process.execPath,
      ["-e", 'setTimeout(() => process.stderr.write("fake app-server trailing diagnostic\\n"), 40)'],
      { stdio: ["ignore", "ignore", process.stderr] }
    )
    process.exit(17)
  }
  if (turn.prompt.includes("[crash]")) process.exit(17)
  if (turn.prompt.includes("[generic-tool]")) {
    const item = {
      id: `generic_${turn.id}`,
      type: "webSearch",
      query: "private secret search",
      action: { type: "search", query: "private secret search" },
    }
    turn.genericItem = item
    notification("item/started", {
      threadId: turn.threadId,
      turnId: turn.id,
      item,
    })
    requestApproval(turn, "item/commandExecution/requestApproval")
    return
  }
  if (turn.prompt.includes("[tool]") && turn.prompt.includes("[approval]")) {
    const completedItem = {
      id: `tool_${turn.id}`,
      type: "commandExecution",
      command: "printf tool",
    }
    notification("item/started", {
      threadId: turn.threadId,
      turnId: turn.id,
      item: completedItem,
    })
    notification("item/completed", {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { ...completedItem, status: "completed" },
    })
    const approvalItem = {
      id: `command_${turn.id}`,
      type: "commandExecution",
      command: "printf approval",
    }
    turn.approvalItem = approvalItem
    turn.completedTools = [{ ...completedItem, status: "completed" }]
    notification("item/started", {
      threadId: turn.threadId,
      turnId: turn.id,
      item: approvalItem,
    })
    requestApproval(turn, "item/commandExecution/requestApproval")
    return
  }
  if (turn.prompt.includes("[approval]")) {
    const item = {
      id: `command_${turn.id}`,
      type: "commandExecution",
      command: "printf approval",
    }
    turn.approvalItem = item
    notification("item/started", { threadId: turn.threadId, turnId: turn.id, item })
    requestApproval(turn, "item/commandExecution/requestApproval")
    return
  }
  if (turn.prompt.includes("[file]")) {
    const item = { id: `file_${turn.id}`, type: "fileChange" }
    turn.approvalItem = item
    notification("item/started", { threadId: turn.threadId, turnId: turn.id, item })
    requestApproval(turn, "item/fileChange/requestApproval")
    return
  }
  if (turn.prompt.includes("[wait]")) return
  if (turn.prompt.includes("[tool]")) {
    const item = { id: `command_${turn.id}`, type: "commandExecution", command: "printf tool" }
    notification("item/started", { threadId: turn.threadId, turnId: turn.id, item })
    notification("item/completed", {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { ...item, status: "completed" },
    })
    notification("item/agentMessage/delta", {
      threadId: turn.threadId,
      turnId: turn.id,
      delta: "tool complete",
    })
    completeTurn(turn, { text: "tool complete", tools: [{ ...item, status: "completed" }] })
    return
  }
  if (turn.prompt.includes("hello")) {
    notification("item/agentMessage/delta", {
      threadId: turn.threadId,
      turnId: turn.id,
      delta: "hello ",
    })
    notification("item/agentMessage/delta", {
      threadId: turn.threadId,
      turnId: turn.id,
      delta: "world",
    })
    completeTurn(turn, { text: "hello world" })
    return
  }
  notification("item/agentMessage/delta", {
    threadId: turn.threadId,
    turnId: turn.id,
    delta: "ok",
  })
  completeTurn(turn)
}

function handleRequest(message) {
  if (message.method === "initialize") {
    if (process.argv.includes("--ignore-initialize")) return
    sendSplit({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2026-01-01",
        serverInfo: { name: "fake-app-server", version: "0.1.0" },
        capabilities: {},
      },
    })
    return
  }
  if (!initialized) {
    reject(message.id, "initialize_required")
    return
  }
  if (message.method === "thread/start") {
    const id = `thr_${state.nextThread++}`
    state.threads[id] = { id, turns: [] }
    saveState()
    respond(message.id, { thread: state.threads[id] })
    return
  }
  if (message.method === "thread/read") {
    const thread = state.threads[message.params?.threadId]
    if (!thread) return reject(message.id, "thread_not_found")
    respond(message.id, { thread })
    return
  }
  if (message.method === "thread/resume") {
    const thread = state.threads[message.params?.threadId]
    if (!thread) return reject(message.id, "thread_not_found")
    respond(message.id, { thread })
    return
  }
  if (message.method === "turn/start") {
    const turn = {
      id: `turn_${state.nextTurn++}`,
      threadId: message.params?.threadId ?? "thr_1",
      prompt: promptFrom(message.params),
      completed: false,
    }
    turns.set(turn.id, turn)
    saveState()
    if (turn.prompt.includes("[crash]") || turn.prompt.includes("[crash-stderr]")) {
      driveTurn(turn)
      return
    }
    respond(message.id, { turn: { id: turn.id } })
    driveTurn(turn)
    return
  }
  if (message.method === "turn/interrupt") {
    const turn = turns.get(message.params?.turnId)
    respond(message.id, {})
    if (turn && !turn.completed) completeTurn(turn, { status: "interrupted", text: "" })
    return
  }
  if (message.method === "test/timeout") return
  if (message.method === "test/ignore-term") {
    process.on("SIGTERM", () => {})
    respond(message.id, { ok: true })
    return
  }
  if (message.method === "test/malformed") {
    process.stdout.write("{not valid JSON}\n")
    respond(message.id, { ok: true })
    return
  }
  if (message.method === "test/stderr") {
    process.stderr.write("fake app-server diagnostic\n")
    respond(message.id, { ok: true })
    return
  }
  reject(message.id, "method_not_found")
}

function handleResponse(message) {
  const turn = approvalRequests.get(message.id)
  if (!turn) return
  approvalRequests.delete(message.id)
  turn.approval = Object.hasOwn(message, "result") ? message.result : message.error
  if (turn.genericItem && !turn.genericCompleted) {
    const completedItem = { ...turn.genericItem }
    turn.genericCompleted = true
    turn.completedTools = [completedItem]
    notification("item/completed", {
      threadId: turn.threadId,
      turnId: turn.id,
      item: completedItem,
    })
    return
  }
  const accepted = turn.approval?.decision === "accept"
  const item = { ...turn.approvalItem, status: accepted ? "completed" : "declined" }
  notification("item/completed", { threadId: turn.threadId, turnId: turn.id, item })
  const text =
    turn.finalText ?? (accepted ? "approval accepted" : "approval declined")
  notification("item/agentMessage/delta", {
    threadId: turn.threadId,
    turnId: turn.id,
    delta: text,
  })
  completeTurn(turn, { text, tools: [...(turn.completedTools ?? []), item] })
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write("invalid client JSON\n")
    return
  }
  if (message?.jsonrpc !== "2.0") return
  if (typeof message.method === "string") {
    if (Object.hasOwn(message, "id")) handleRequest(message)
    if (message.method === "initialized") initialized = true
    return
  }
  if (Object.hasOwn(message ?? {}, "id")) handleResponse(message)
})
