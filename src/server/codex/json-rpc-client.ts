import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type {
  CodexClientInfo,
  CodexJsonRpcClientEvent,
  CodexJsonRpcClientListener,
  CodexProcessOptions,
  JsonRpcId,
} from "./codex-types.js"

export type { CodexClientInfo, CodexJsonRpcClientEvent, CodexProcessOptions, JsonRpcId }

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_STOP_TIMEOUT_MS = 1_000

type PendingRequest = {
  reject: (reason: Error) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type JsonRpcMessage = Record<string, unknown>

export class CodexJsonRpcClient {
  readonly #listeners = new Set<CodexJsonRpcClientListener>()
  readonly #pendingRequests = new Map<JsonRpcId, PendingRequest>()
  readonly #stdoutDecoder = new StringDecoder("utf8")
  #child: ChildProcessWithoutNullStreams | undefined
  #nextRequestId = 1
  #state: "idle" | "starting" | "started" | "stopping" | "stopped" = "idle"
  #stderr = ""
  #stdoutBuffer = ""
  #stopPromise: Promise<void> | undefined

  constructor(readonly processOptions: CodexProcessOptions) {}

  get stderr(): string {
    return this.#stderr
  }

  async start(
    clientInfo: CodexClientInfo,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<void> {
    if (this.#state === "started") {
      return
    }
    if (this.#state !== "idle") {
      throw new Error("app_server_stopped")
    }

    this.#state = "starting"
    this.#child = spawn(this.processOptions.command, this.processOptions.args, {
      cwd: this.processOptions.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#attachProcessListeners(this.#child)

    try {
      const initializeResult = await this.#request<unknown>("initialize", {
        clientInfo,
      }, timeoutMs)
      if (!isRecord(initializeResult)) {
        throw new Error("invalid_initialize_response")
      }
      this.#write({ jsonrpc: "2.0", method: "initialized", params: {} })
      this.#state = "started"
    } catch (error) {
      this.#state = "stopped"
      this.#rejectPending(error instanceof Error ? error : new Error(String(error)))
      this.#child.kill("SIGKILL")
      throw error
    }
  }

  request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.#state !== "started") {
      return Promise.reject(new Error("app_server_not_started"))
    }
    return this.#request(method, params, timeoutMs)
  }

  #request<T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("invalid_request_timeout"))
    }

    const id = this.#nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pendingRequests.delete(id)) {
          reject(new Error("app_server_request_timeout"))
        }
      }, timeoutMs)
      this.#pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      try {
        this.#write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timeout)
        this.#pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  respond(id: JsonRpcId, result: unknown = null): void {
    this.#write({ jsonrpc: "2.0", id, result })
  }

  subscribe(listener: CodexJsonRpcClientListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async stop(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("invalid_stop_timeout")
    }
    if (!this.#child || this.#state === "stopped") {
      this.#state = "stopped"
      this.#rejectPending(new Error("app_server_stopped"))
      return
    }

    this.#state = "stopping"
    this.#rejectPending(new Error("app_server_stopped"))
    const child = this.#child
    this.#stopPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        child.off("exit", finish)
        this.#state = "stopped"
        resolve()
      }
      child.once("exit", finish)
      if (timeoutMs === 0) {
        try {
          child.kill("SIGKILL")
        } finally {
          finish()
        }
        return
      }
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } finally {
          finish()
        }
      }, timeoutMs)
      try {
        child.kill("SIGTERM")
      } catch {
        try {
          child.kill("SIGKILL")
        } finally {
          finish()
        }
      }
    })
    return this.#stopPromise
  }

  #attachProcessListeners(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString()
    })
    child.on("error", (error) => {
      this.#emit({ type: "protocol_error", message: error.message })
      this.#state = "stopped"
      this.#rejectPending(new Error("app_server_exited"))
    })
    child.once("exit", (code, signal) => {
      this.#state = "stopped"
      this.#rejectPending(new Error("app_server_exited"))
    })
    child.once("close", (code, signal) => {
      this.#state = "stopped"
      this.#rejectPending(new Error("app_server_exited"))
      this.#emit({ type: "exit", code, signal, stderr: this.#stderr })
    })
  }

  #consumeStdout(chunk: Buffer): void {
    this.#stdoutBuffer += this.#stdoutDecoder.write(chunk)
    let lineEnd = this.#stdoutBuffer.indexOf("\n")
    while (lineEnd !== -1) {
      const line = this.#stdoutBuffer.slice(0, lineEnd).trim()
      this.#stdoutBuffer = this.#stdoutBuffer.slice(lineEnd + 1)
      if (line.length > 0) {
        this.#handleLine(line)
      }
      lineEnd = this.#stdoutBuffer.indexOf("\n")
    }
  }

  #handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#emit({ type: "protocol_error", message: "invalid_json", raw: line })
      return
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.#emit({ type: "protocol_error", message: "invalid_json_rpc_message", raw: line })
      return
    }

    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) {
        if (!isJsonRpcId(message.id)) {
          this.#emit({ type: "protocol_error", message: "invalid_server_request_id", raw: line })
          return
        }
        this.#emit({
          type: "server_request",
          id: message.id,
          method: message.method,
          ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
        })
        return
      }
      this.#emit({
        type: "notification",
        method: message.method,
        ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
      })
      return
    }

    if (!Object.hasOwn(message, "id") || !isJsonRpcId(message.id)) {
      this.#emit({ type: "protocol_error", message: "invalid_json_rpc_message", raw: line })
      return
    }
    const pending = this.#pendingRequests.get(message.id)
    if (!pending) {
      this.#emit({ type: "protocol_error", message: "unknown_response_id", raw: line })
      return
    }
    this.#pendingRequests.delete(message.id)
    clearTimeout(pending.timeout)
    if (Object.hasOwn(message, "error")) {
      pending.reject(toResponseError(message.error))
      return
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(new Error("invalid_json_rpc_response"))
      return
    }
    pending.resolve(message.result)
  }

  #write(message: JsonRpcMessage): void {
    if (!this.#child || !this.#child.stdin.writable) {
      throw new Error("app_server_stopped")
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #rejectPending(error: Error): void {
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pendingRequests.clear()
  }

  #emit(event: CodexJsonRpcClientEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Subscriber exceptions must not interrupt the protocol stream.
      }
    }
  }
}

function isRecord(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number"
}

function toResponseError(value: unknown): Error {
  if (isRecord(value) && typeof value.message === "string") {
    return new Error(value.message)
  }
  return new Error("app_server_request_failed")
}
