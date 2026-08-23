import readline from "node:readline"

let initialized = false
let nextThread = 1
let nextTurn = 1
const turns = new Map()
const approvalRequests = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendSplit(message) {
  const serialized = `${JSON.stringify(message)}\n`
  const middle = Math.ceil(serialized.length / 2)
  process.stdout.write(serialized.slice(0, middle))
  setTimeout(() => process.stdout.write(serialized.slice(middle)), 0)
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

function completeTurn(turn) {
  if (turn.completed) return
  turn.completed = true
  notification("turn/completed", { threadId: turn.threadId, turn: { id: turn.id } })
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
  if (turn.prompt.includes("[crash]")) {
    process.exit(17)
  }
  if (turn.prompt.includes("[approval]")) {
    requestApproval(turn, "item/commandExecution/requestApproval")
    return
  }
  if (turn.prompt.includes("[file]")) {
    requestApproval(turn, "item/fileChange/requestApproval")
    return
  }
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
    completeTurn(turn)
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
    completeTurn(turn)
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
    initialized = true
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
    respond(message.id, { thread: { id: `thr_${nextThread++}` } })
    return
  }
  if (message.method === "turn/start") {
    const turn = {
      id: `turn_${nextTurn++}`,
      threadId: message.params?.threadId ?? "thr_1",
      prompt: promptFrom(message.params),
      completed: false,
    }
    turns.set(turn.id, turn)
    if (turn.prompt.includes("[crash]")) {
      driveTurn(turn)
      return
    }
    respond(message.id, { turn: { id: turn.id } })
    driveTurn(turn)
    return
  }
  if (message.method === "test/timeout") return
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
  completeTurn(turn)
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
    return
  }
  if (Object.hasOwn(message ?? {}, "id")) handleResponse(message)
})
