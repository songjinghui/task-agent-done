import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type {
  ApprovalDecision,
  ConversationEvent,
  MessageTurn,
} from "../shared/contracts.js"
import type { AgentAdapter, AgentAdapterEvent } from "./agent/agent-adapter.js"
import type { ServerConfig } from "./config.js"
import { ConversationRepository } from "./conversation-repository.js"
import { openDatabase } from "./database.js"
import {
  startTaskMux,
  configureTaskMuxFrontend,
  type RuntimeCodexClient,
  type RuntimeSignalSource,
} from "./main.js"
import type {
  CodexClientInfo,
  CodexJsonRpcClientEvent,
  CodexProcessOptions,
} from "./codex/json-rpc-client.js"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("startTaskMux", () => {
  it("recovers stale running rows and listens only on the configured loopback host", async () => {
    const config = makeConfig()
    const path = join(config.dataDir, "taskmux.sqlite")
    const seed = openDatabase(path)
    const seededRepository = new ConversationRepository(seed)
    const stale = seededRepository.create({ id: "stale", externalSessionId: "thr-stale" })
    seededRepository.setStatus(stale.id, "running")
    seed.close()
    const harness = makeRuntimeHarness()

    const running = await startTaskMux(config, harness.dependencies)

    expect(running.repository.getById(stale.id)?.status).toBe("interrupted")
    expect(harness.listen.mock.calls[0]?.[0]).toBe(running.app)
    expect(harness.listen.mock.calls[0]?.[1]).toEqual({
      host: "127.0.0.1",
      port: config.port,
    })
    expect(harness.processOptions[0]).toEqual({
      command: "codex",
      args: ["app-server"],
      cwd: config.workspace,
    })
    await running.shutdown()
  })

  it("maps an authentication handshake failure to degraded health without leaking details", async () => {
    const harness = makeRuntimeHarness({
      startErrors: [new Error("Unauthorized: token from /secret/config")],
    })
    const running = await startTaskMux(makeConfig(), harness.dependencies)

    expect(running.health()).toEqual({
      status: "degraded",
      error: {
        code: "codex_not_authenticated",
        message: "Codex CLI is not authenticated. Run codex login and try again.",
      },
    })
    expect(JSON.stringify(running.health())).not.toContain("secret")
    const response = await running.app.inject({ method: "GET", url: "/api/health" })
    expect(response.statusCode).toBe(503)
    await running.shutdown()
  })

  it("restarts once, keeps the HTTP service, and releases an active turn first", async () => {
    const harness = makeRuntimeHarness()
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()
    await running.service.sendText(conversation.id, "first")
    expect(running.repository.getById(conversation.id)?.status).toBe("running")

    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)

    expect(running.repository.getById(conversation.id)?.status).toBe("failed")
    expect(harness.listen).toHaveBeenCalledOnce()
    await expect(
      running.service.sendText(conversation.id, "after restart")
    ).resolves.toBeUndefined()
    await running.shutdown()
  })

  it("does not loop after a second consecutive crash and reports degraded health", async () => {
    const harness = makeRuntimeHarness()
    const running = await startTaskMux(makeConfig(), harness.dependencies)

    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)
    harness.adapters[0]!.complete("thr-1")
    harness.clients[1]!.emitExit()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.clients).toHaveLength(2)
    expect(running.health()).toEqual({
      status: "degraded",
      error: {
        code: "app_server_exited",
        message: "Agent service exited repeatedly. Restart TaskMux to try again.",
      },
    })
    await running.shutdown()
  })

  it("resets the restart budget only after a later completed turn", async () => {
    const harness = makeRuntimeHarness()
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)
    await running.service.sendText(conversation.id, "successful")
    harness.adapters[1]!.complete("thr-1")
    harness.clients[1]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(3)

    expect(running.health()).toEqual({ status: "ok" })
    await running.shutdown()
  })

  it("shuts down idempotently, cancels active work, stops the client, and removes signal handlers", async () => {
    const signals = new FakeSignals()
    const harness = makeRuntimeHarness({ signals })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()
    await running.service.sendText(conversation.id, "active")

    expect(signals.count("SIGINT")).toBe(1)
    expect(signals.count("SIGTERM")).toBe(1)
    signals.emit("SIGINT")
    await expect.poll(() => harness.clients[0]!.stopCalls).toBe(1)
    await running.shutdown()

    expect(harness.adapters[0]!.cancelCalls).toEqual(["thr-1"])
    expect(harness.clients[0]!.stopCalls).toBe(1)
    expect(signals.count("SIGINT")).toBe(0)
    expect(signals.count("SIGTERM")).toBe(0)
  })

  it.each([true, false])("injects the %s frontend mode without starting real Vite", async (dev) => {
    const harness = makeRuntimeHarness()
    const configureFrontend = vi.fn(async (_app: FastifyInstance, mode: boolean) => {})
    const running = await startTaskMux(
      { ...makeConfig(), dev },
      { ...harness.dependencies, configureFrontend }
    )

    expect(configureFrontend.mock.calls[0]?.[0]).toBe(running.app)
    expect(configureFrontend.mock.calls[0]?.[1]).toBe(dev)
    await running.shutdown()
  })
})

describe("configureTaskMuxFrontend", () => {
  it("serves production assets and falls back only for non-API navigation", async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), "taskmux-static-"))
    directories.push(staticRoot)
    writeFileSync(join(staticRoot, "index.html"), "<main>TaskMux shell</main>")
    const app = Fastify({ logger: false })
    app.get("/api/known", async () => ({ ok: true }))
    await configureTaskMuxFrontend(app, false, { staticRoot })

    const navigation = await app.inject({ method: "GET", url: "/conversation/one" })
    expect(navigation.statusCode).toBe(200)
    expect(navigation.body).toContain("TaskMux shell")
    const missingApi = await app.inject({ method: "GET", url: "/api/missing" })
    expect(missingApi.statusCode).toBe(404)
    expect(missingApi.json()).toEqual({
      error: { code: "route_not_found", message: "Route not found." },
    })
    const apiRoot = await app.inject({ method: "GET", url: "/api" })
    expect(apiRoot.statusCode).toBe(404)
    expect(apiRoot.json()).toEqual({
      error: { code: "route_not_found", message: "Route not found." },
    })
    await app.close()
  })

  it("uses injected Vite middleware in development and keeps API routing", async () => {
    const app = Fastify({ logger: false })
    app.get("/api/known", async () => ({ ok: true }))
    const close = vi.fn(async () => {})
    const cleanup = await configureTaskMuxFrontend(app, true, {
      createViteServer: async () => ({
        close,
        middlewares(request, response, next) {
          if (request.url?.startsWith("/api/")) {
            next()
            return
          }
          response.statusCode = 200
          response.end("development shell")
        },
      }),
    })

    const navigation = await app.inject({ method: "GET", url: "/conversation/one" })
    expect(navigation.body).toBe("development shell")
    expect((await app.inject({ method: "GET", url: "/api/known" })).json()).toEqual({ ok: true })
    await cleanup?.()
    expect(close).toHaveBeenCalledOnce()
    await app.close()
  })
})

class FakeClient implements RuntimeCodexClient {
  readonly listeners = new Set<(event: CodexJsonRpcClientEvent) => void>()
  stopCalls = 0

  constructor(readonly startError?: Error) {}

  async start(_clientInfo: CodexClientInfo): Promise<void> {
    if (this.startError) throw this.startError
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
  }

  subscribe(listener: (event: CodexJsonRpcClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitExit(): void {
    for (const listener of [...this.listeners]) {
      listener({ type: "exit", code: 17, signal: null, stderr: "secret stderr" })
    }
  }
}

class FakeAdapter implements AgentAdapter {
  readonly listeners = new Set<(event: AgentAdapterEvent) => void>()
  readonly operations = new Map<string, string>()
  readonly active = new Set<string>()
  readonly cancelCalls: string[] = []
  nextTurn = 1

  constructor(client: FakeClient) {
    client.subscribe((event) => {
      if (event.type !== "exit") return
      for (const externalSessionId of [...this.active]) {
        this.emit(externalSessionId, {
          type: "error",
          code: "app_server_exited",
          message: "Agent server exited unexpectedly.",
          terminal: true,
          scope: "session",
        })
      }
      this.active.clear()
    })
  }

  async createSession(): Promise<{ externalSessionId: string }> {
    return { externalSessionId: "thr-1" }
  }
  async readSession(): Promise<MessageTurn[]> {
    return []
  }
  async resumeSession(): Promise<void> {}
  async sendText(externalSessionId: string, _text: string, operationId: string) {
    this.operations.set(externalSessionId, operationId)
    this.active.add(externalSessionId)
    return { turnId: `turn-${this.nextTurn++}` }
  }
  async cancelTurn(externalSessionId: string): Promise<void> {
    this.cancelCalls.push(externalSessionId)
  }
  async respondToApproval(_requestId: string, _decision: ApprovalDecision): Promise<void> {}
  subscribe(listener: (event: AgentAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  complete(externalSessionId: string): void {
    this.emit(externalSessionId, {
      type: "turn_completed",
      turnId: "turn-1",
    })
  }
  emit(externalSessionId: string, payload: ConversationEvent): void {
    const operationId = this.operations.get(externalSessionId)
    for (const listener of [...this.listeners]) {
      listener({ externalSessionId, operationId, payload })
    }
  }
}

class FakeSignals implements RuntimeSignalSource {
  readonly handlers = new Map<NodeJS.Signals, Set<() => void>>()
  on(signal: NodeJS.Signals, handler: () => void): void {
    const handlers = this.handlers.get(signal) ?? new Set()
    handlers.add(handler)
    this.handlers.set(signal, handlers)
  }
  off(signal: NodeJS.Signals, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler)
  }
  emit(signal: NodeJS.Signals): void {
    for (const handler of [...(this.handlers.get(signal) ?? [])]) handler()
  }
  count(signal: NodeJS.Signals): number {
    return this.handlers.get(signal)?.size ?? 0
  }
}

function makeRuntimeHarness(options: {
  startErrors?: Array<Error | undefined>
  signals?: RuntimeSignalSource
} = {}) {
  const clients: FakeClient[] = []
  const adapters: FakeAdapter[] = []
  const processOptions: CodexProcessOptions[] = []
  const listen = vi.fn(
    async (
      _app: FastifyInstance,
      _options: { host: "127.0.0.1"; port: number }
    ) => "http://127.0.0.1:4317"
  )
  return {
    clients,
    adapters,
    processOptions,
    listen,
    dependencies: {
      diagnose: async () => ({ status: "ok" as const }),
      createClient: (clientOptions: CodexProcessOptions) => {
        processOptions.push(clientOptions)
        const client = new FakeClient(options.startErrors?.[clients.length])
        clients.push(client)
        return client
      },
      createAdapter: (client: RuntimeCodexClient) => {
        const adapter = new FakeAdapter(client as FakeClient)
        adapters.push(adapter)
        return adapter
      },
      configureFrontend: async () => {},
      listen,
      signals: options.signals ?? new FakeSignals(),
    },
  }
}

function makeConfig(): ServerConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "taskmux-main-"))
  directories.push(dataDir)
  return {
    workspace: "/fixed/workspace",
    host: "127.0.0.1",
    port: 4317,
    dataDir,
    dev: false,
  }
}
