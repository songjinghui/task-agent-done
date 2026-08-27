import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type { DatabaseSync } from "node:sqlite"
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
import {
  CodexRequestError,
  type CodexClientInfo,
  type CodexJsonRpcClientEvent,
  type CodexProcessOptions,
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

  it.each(["app_server_request_timeout", "invalid_initialize_response"])(
    "keeps HTTP available for unsupported initialize failure %s",
    async (message) => {
      const harness = makeRuntimeHarness({ startErrors: [new Error(message)] })
      const running = await startTaskMux(makeConfig(), harness.dependencies)

      expect(running.health()).toEqual({
        status: "degraded",
        error: {
          code: "codex_version_unsupported",
          message: "This Codex CLI version does not support app-server.",
        },
      })
      const response = await running.app.inject({ method: "GET", url: "/api/health" })
      expect(response.statusCode).toBe(503)
      await running.shutdown()
    }
  )

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

  it("replaces a client after recoverable turn/start failure without replaying the prompt", async () => {
    const requestError = recoverableTurnStartError()
    const harness = makeRuntimeHarness({ sendErrors: [requestError] })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first attempt")).rejects.toBe(
      requestError
    )
    expect(running.repository.getById(conversation.id)?.status).toBe("failed")
    await expect.poll(() => harness.clients.length).toBe(2)

    expect(harness.adapters[0]!.sendTextCalls).toEqual(["first attempt"])
    expect(harness.adapters[1]!.sendTextCalls).toEqual([])
    await expect(
      running.service.sendText(conversation.id, "explicit retry")
    ).resolves.toBeUndefined()
    expect(harness.adapters[1]!.sendTextCalls).toEqual(["explicit retry"])
    await running.shutdown()
  })

  it("holds an immediate explicit retry until the replacement client is ready", async () => {
    const retiredStop = deferred<void>()
    const replacementStart = deferred<void>()
    const harness = makeRuntimeHarness({
      sendErrors: [recoverableTurnStartError()],
      stopGates: [retiredStop],
      startGates: [undefined, replacementStart],
    })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first attempt")).rejects.toThrow()
    const retry = running.service.sendText(conversation.id, "immediate retry")
    let retrySettled = false
    void retry.finally(() => {
      retrySettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(retrySettled).toBe(false)
    expect(harness.clients).toHaveLength(1)
    expect(running.health()).toEqual({ status: "ok" })

    retiredStop.resolve()
    await expect.poll(() => harness.clients.length).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(retrySettled).toBe(false)
    expect(harness.adapters[1]!.sendTextCalls).toEqual([])

    replacementStart.resolve()
    await expect(retry).resolves.toBeUndefined()
    expect(harness.adapters[0]!.sendTextCalls).toEqual(["first attempt"])
    expect(harness.adapters[1]!.sendTextCalls).toEqual(["immediate retry"])
    await running.shutdown()
  })

  it("releases a waiting explicit retry when replacement startup fails", async () => {
    const retiredStop = deferred<void>()
    const replacementStart = deferred<void>()
    const harness = makeRuntimeHarness({
      sendErrors: [recoverableTurnStartError()],
      stopGates: [retiredStop],
      startGates: [undefined, replacementStart],
      startErrors: [undefined, new Error("replacement failed")],
    })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first attempt")).rejects.toThrow()
    const retry = running.service.sendText(conversation.id, "immediate retry")
    retiredStop.resolve()
    await expect.poll(() => harness.clients.length).toBe(2)
    replacementStart.resolve()

    await expect(retry).rejects.toThrow("app_server_not_started")
    expect(running.repository.getById(conversation.id)?.status).toBe("failed")
    expect(running.health()).toEqual({
      status: "degraded",
      error: {
        code: "codex_request_failed",
        message: "Agent service failed repeatedly. Restart TaskMux to try again.",
      },
    })
    await running.shutdown()
  })

  it("does not restart for a non-recoverable Codex business request failure", async () => {
    const requestError = new CodexRequestError({
      code: "codex_request_failed",
      message: "thread_not_found",
      method: "turn/start",
      recoverable: false,
    })
    const harness = makeRuntimeHarness({ sendErrors: [requestError] })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first attempt")).rejects.toBe(
      requestError
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.clients).toHaveLength(1)
    await expect(
      running.service.sendText(conversation.id, "explicit retry")
    ).resolves.toBeUndefined()
    expect(harness.adapters[0]!.sendTextCalls).toEqual([
      "first attempt",
      "explicit retry",
    ])
    await running.shutdown()
  })

  it("degrades after consecutive recoverable request failures without a restart loop", async () => {
    const harness = makeRuntimeHarness({
      sendErrors: [recoverableTurnStartError(), recoverableTurnStartError()],
    })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first")).rejects.toThrow()
    await expect.poll(() => harness.clients.length).toBe(2)
    await expect(running.service.sendText(conversation.id, "second")).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.clients).toHaveLength(2)
    expect(running.health()).toEqual({
      status: "degraded",
      error: {
        code: "codex_request_failed",
        message: "Agent service failed repeatedly. Restart TaskMux to try again.",
      },
    })
    await running.shutdown()
  })

  it("deduplicates a recoverable request failure followed by the retired client exit", async () => {
    const harness = makeRuntimeHarness({ sendErrors: [recoverableTurnStartError()] })
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    const conversation = await running.service.create()

    await expect(running.service.sendText(conversation.id, "first")).rejects.toThrow()
    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.clients).toHaveLength(2)
    expect(harness.clients[0]!.stopCalls).toBeGreaterThanOrEqual(1)
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

  it("does not reset restart budget for a current adapter completion rejected by the service", async () => {
    const harness = makeRuntimeHarness()
    const running = await startTaskMux(makeConfig(), harness.dependencies)
    await running.service.create()

    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)
    harness.adapters[1]!.complete("thr-1")
    harness.clients[1]!.emitExit()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(harness.clients).toHaveLength(2)
    expect(running.health()).toMatchObject({ status: "degraded" })
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

  it("rolls back client, frontend, app, database, and listeners when listen fails", async () => {
    const config = makeConfig()
    const database = openDatabase(join(config.dataDir, "taskmux.sqlite"))
    const closeDatabase = vi.spyOn(database, "close")
    const closeFrontend = vi.fn(async () => {})
    const closeApp = vi.fn(async () => {})
    const signals = new FakeSignals()
    const harness = makeRuntimeHarness({ signals })
    const listenError = Object.assign(new Error("address already in use"), {
      code: "EADDRINUSE",
    })

    await expect(
      startTaskMux(config, {
        ...harness.dependencies,
        openDatabase: () => database,
        configureFrontend: async (app) => {
          app.addHook("onClose", closeApp)
          return closeFrontend
        },
        listen: async () => {
          throw listenError
        },
      })
    ).rejects.toBe(listenError)

    const databaseCloseCalls = closeDatabase.mock.calls.length
    if (databaseCloseCalls === 0) database.close()
    expect(databaseCloseCalls).toBe(1)
    expect(closeApp).toHaveBeenCalledOnce()
    expect(closeFrontend).toHaveBeenCalledOnce()
    expect(harness.clients[0]!.stopCalls).toBe(1)
    expect(harness.clients[0]!.listeners.size).toBe(0)
    expect(signals.count("SIGINT")).toBe(0)
    expect(signals.count("SIGTERM")).toBe(0)
  })

  it("rolls back the database when diagnostics throw after it opens", async () => {
    const config = makeConfig()
    const database = openDatabase(join(config.dataDir, "taskmux.sqlite"))
    const closeDatabase = vi.spyOn(database, "close")
    const diagnosticError = new Error("diagnostic runner failed")

    await expect(
      startTaskMux(config, {
        openDatabase: () => database,
        diagnose: async () => {
          throw diagnosticError
        },
      })
    ).rejects.toBe(diagnosticError)

    const databaseCloseCalls = closeDatabase.mock.calls.length
    if (databaseCloseCalls === 0) database.close()
    expect(databaseCloseCalls).toBe(1)
  })

  it("closes a migrated database when repository composition fails", async () => {
    const compositionError = new Error("repository composition failed")
    const close = vi.fn()
    const database = {
      prepare() {
        throw compositionError
      },
      close,
    } as unknown as DatabaseSync

    await expect(
      startTaskMux(makeConfig(), { openDatabase: () => database })
    ).rejects.toBe(compositionError)

    expect(close).toHaveBeenCalledOnce()
  })

  it("rolls back an unclassified App Server start failure", async () => {
    const config = makeConfig()
    const database = openDatabase(join(config.dataDir, "taskmux.sqlite"))
    const closeDatabase = vi.spyOn(database, "close")
    const startError = new Error("unexpected transport construction failure")
    const harness = makeRuntimeHarness({ startErrors: [startError] })

    await expect(
      startTaskMux(config, {
        ...harness.dependencies,
        openDatabase: () => database,
      })
    ).rejects.toBe(startError)

    const databaseCloseCalls = closeDatabase.mock.calls.length
    if (databaseCloseCalls === 0) database.close()
    expect(databaseCloseCalls).toBe(1)
    expect(harness.clients[0]!.stopCalls).toBeGreaterThanOrEqual(1)
    expect(harness.clients[0]!.listeners.size).toBe(0)
  })

  it("stops a restarting client and waits for its pending initialize before closing the database", async () => {
    const restartStart = deferred<void>()
    const config = makeConfig()
    const database = openDatabase(join(config.dataDir, "taskmux.sqlite"))
    const closeDatabase = vi.spyOn(database, "close")
    const harness = makeRuntimeHarness({ startGates: [undefined, restartStart] })
    const running = await startTaskMux(config, {
      ...harness.dependencies,
      openDatabase: () => database,
    })

    harness.clients[0]!.emitExit()
    await expect.poll(() => harness.clients.length).toBe(2)
    let shutdownSettled = false
    const shutdown = running.shutdown().then(() => {
      shutdownSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const stopCallsBeforeInitializeSettled = harness.clients[1]!.stopCalls
    const databaseCallsBeforeInitializeSettled = closeDatabase.mock.calls.length

    restartStart.resolve()
    await shutdown

    expect(stopCallsBeforeInitializeSettled).toBe(1)
    expect(databaseCallsBeforeInitializeSettled).toBe(0)
    expect(shutdownSettled).toBe(true)
    expect(closeDatabase).toHaveBeenCalledOnce()
    expect(harness.clients[1]!.listeners.size).toBe(0)
    expect(harness.listen).toHaveBeenCalledOnce()
  })

  it("removes the first signal listener when the second registration fails", async () => {
    const registered = new FakeSignals()
    const signalError = new Error("signal registration failed")
    const removalError = new Error("signal removal failed")
    const signals: RuntimeSignalSource = {
      on(signal, handler) {
        if (signal === "SIGTERM") throw signalError
        registered.on(signal, handler)
      },
      off(signal, handler) {
        registered.off(signal, handler)
        if (signal === "SIGINT") throw removalError
      },
    }
    const harness = makeRuntimeHarness({ signals })

    await expect(
      startTaskMux(makeConfig(), harness.dependencies)
    ).rejects.toBe(signalError)

    expect(registered.count("SIGINT")).toBe(0)
    expect(harness.clients[0]!.stopCalls).toBe(1)
    expect(harness.clients[0]!.listeners.size).toBe(0)
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

  it("keeps known and missing API paths out of Vite middleware", async () => {
    const app = Fastify({ logger: false })
    app.get("/api/known", async () => ({ ok: true }))
    const close = vi.fn(async () => {})
    const viteRequests: string[] = []
    const cleanup = await configureTaskMuxFrontend(app, true, {
      createViteServer: async () => ({
        close,
        middlewares(request, response) {
          viteRequests.push(request.url ?? "")
          response.statusCode = 200
          response.end("development shell")
        },
      }),
    })

    const navigation = await app.inject({ method: "GET", url: "/conversation/one" })
    expect(navigation.body).toBe("development shell")
    expect((await app.inject({ method: "GET", url: "/api/known" })).json()).toEqual({ ok: true })
    expect((await app.inject({ method: "GET", url: "/api/missing" })).json()).toEqual({
      error: { code: "route_not_found", message: "Route not found." },
    })
    expect((await app.inject({ method: "GET", url: "/api?check=1" })).json()).toEqual({
      error: { code: "route_not_found", message: "Route not found." },
    })
    expect(viteRequests).toEqual(["/conversation/one"])
    await cleanup?.()
    expect(close).toHaveBeenCalledOnce()
    await app.close()
  })

  it("closes an acquired Vite server when middleware registration fails", async () => {
    const app = Fastify({ logger: false })
    const registrationError = new Error("middleware registration failed")
    vi.spyOn(app, "register").mockImplementationOnce(() => {
      throw registrationError
    })
    const close = vi.fn(async () => {})

    await expect(
      configureTaskMuxFrontend(app, true, {
        createViteServer: async () => ({
          close,
          middlewares(_request, _response, next) {
            next()
          },
        }),
      })
    ).rejects.toBe(registrationError)

    expect(close).toHaveBeenCalledOnce()
  })
})

class FakeClient implements RuntimeCodexClient {
  readonly listeners = new Set<(event: CodexJsonRpcClientEvent) => void>()
  stopCalls = 0

  constructor(
    readonly startError?: Error,
    readonly startGate?: Deferred<void>,
    readonly stopGate?: Deferred<void>
  ) {}

  async start(_clientInfo: CodexClientInfo): Promise<void> {
    await this.startGate?.promise
    if (this.startError) throw this.startError
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    await this.stopGate?.promise
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

  emitRequestFailure(error: CodexRequestError): void {
    for (const listener of [...this.listeners]) {
      listener({
        type: "request_failure",
        method: error.method,
        code: error.code,
        message: error.publicMessage,
        recoverable: error.recoverable,
      })
    }
  }
}

class FakeAdapter implements AgentAdapter {
  readonly listeners = new Set<(event: AgentAdapterEvent) => void>()
  readonly operations = new Map<string, string>()
  readonly active = new Set<string>()
  readonly cancelCalls: string[] = []
  nextTurn = 1
  readonly unsubscribeClient: () => void
  readonly sendTextCalls: string[] = []
  #sendError: CodexRequestError | undefined

  constructor(readonly client: FakeClient, sendError?: CodexRequestError) {
    this.#sendError = sendError
    this.unsubscribeClient = client.subscribe((event) => {
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

  dispose(): void {
    this.unsubscribeClient()
  }

  async createSession(): Promise<{ externalSessionId: string }> {
    return { externalSessionId: "thr-1" }
  }
  async readSession(): Promise<MessageTurn[]> {
    return []
  }
  async resumeSession(): Promise<void> {}
  async sendText(externalSessionId: string, text: string, operationId: string) {
    this.sendTextCalls.push(text)
    if (this.#sendError) {
      const error = this.#sendError
      this.#sendError = undefined
      this.client.emitRequestFailure(error)
      throw error
    }
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
  startGates?: Array<Deferred<void> | undefined>
  stopGates?: Array<Deferred<void> | undefined>
  sendErrors?: Array<CodexRequestError | undefined>
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
        const client = new FakeClient(
          options.startErrors?.[clients.length],
          options.startGates?.[clients.length],
          options.stopGates?.[clients.length]
        )
        clients.push(client)
        return client
      },
      createAdapter: (client: RuntimeCodexClient) => {
        const adapter = new FakeAdapter(
          client as FakeClient,
          options.sendErrors?.[adapters.length]
        )
        adapters.push(adapter)
        return adapter
      },
      configureFrontend: async () => {},
      listen,
      signals: options.signals ?? new FakeSignals(),
    },
  }
}

function recoverableTurnStartError(): CodexRequestError {
  return new CodexRequestError({
    code: "codex_request_failed",
    message: "timeout waiting for child process to exit",
    method: "turn/start",
    recoverable: true,
  })
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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
