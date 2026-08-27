import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { DatabaseSync } from "node:sqlite"
import type { FastifyInstance } from "fastify"
import type { AgentAdapter } from "./agent/agent-adapter.js"
import { ReplaceableAgentAdapter } from "./agent/replaceable-agent-adapter.js"
import { buildApp, type AppHealth } from "./app.js"
import {
  diagnoseCodex,
  diagnosticError,
  type CodexDiagnostic,
} from "./codex/codex-diagnostics.js"
import { CodexAppServerAdapter } from "./codex/codex-adapter.js"
import {
  CodexJsonRpcClient,
  type CodexClientInfo,
  type CodexJsonRpcClientEvent,
  type CodexProcessOptions,
} from "./codex/json-rpc-client.js"
import { parseServerConfig, type ServerConfig } from "./config.js"
import { ConversationRepository } from "./conversation-repository.js"
import { ConversationService } from "./conversation-service.js"
import { openDatabase } from "./database.js"
import { EventHub } from "./event-hub.js"

const CLIENT_INFO: CodexClientInfo = {
  name: "taskmux",
  title: "TaskMux",
  version: "0.0.0",
}

export interface RuntimeCodexClient {
  start(clientInfo: CodexClientInfo): Promise<void>
  stop(): Promise<void>
  subscribe(listener: (event: CodexJsonRpcClientEvent) => void): () => void
}

export interface RuntimeSignalSource {
  on(signal: NodeJS.Signals, handler: () => void): void
  off(signal: NodeJS.Signals, handler: () => void): void
}

export type RuntimeDependencies = {
  diagnose?: (command: string) => Promise<CodexDiagnostic>
  createClient?: (options: CodexProcessOptions) => RuntimeCodexClient
  createAdapter?: (client: RuntimeCodexClient) => AgentAdapter
  openDatabase?: (path: string) => DatabaseSync
  configureFrontend?: (
    app: FastifyInstance,
    dev: boolean
  ) => Promise<void | (() => Promise<void>)>
  listen?: (
    app: FastifyInstance,
    options: { host: "127.0.0.1"; port: number }
  ) => Promise<string>
  signals?: RuntimeSignalSource
}

export type RunningTaskMux = {
  app: FastifyInstance
  service: ConversationService
  repository: ConversationRepository
  eventHub: EventHub
  address: string
  health(): AppHealth
  shutdown(): Promise<void>
}

export async function startTaskMux(
  config: ServerConfig,
  dependencies: RuntimeDependencies = {}
): Promise<RunningTaskMux> {
  mkdirSync(config.dataDir, { recursive: true })
  const database = (dependencies.openDatabase ?? openDatabase)(
    join(config.dataDir, "taskmux.sqlite")
  )
  let repository: ConversationRepository
  const eventHub = new EventHub()
  const adapterProxy = new ReplaceableAgentAdapter()
  const signals = dependencies.signals ?? process
  let app: FastifyInstance | undefined
  let service: ConversationService | undefined
  let closeFrontend: void | (() => Promise<void>)
  let health: AppHealth = { status: "ok" }
  let currentClient: RuntimeCodexClient | undefined
  let startingClient: RuntimeCodexClient | undefined
  let currentExitUnsubscribe: (() => void) | undefined
  let restartPromise: Promise<void> | undefined
  let restartBudget = 1
  let awaitingRecoveryCompletion = false
  let closing = false
  let sigintRegistered = false
  let sigtermRegistered = false
  let databaseClosed = false
  let shutdownPromise: Promise<void> | undefined
  const onSignal = () => {
    void shutdown()
  }
  const unsubscribeRestartEvents = eventHub.subscribe((event) => {
    if (awaitingRecoveryCompletion && event.payload.type === "turn_completed") {
      restartBudget = 1
      awaitingRecoveryCompletion = false
      health = { status: "ok" }
    }
  })

  async function startClient(recovery: boolean): Promise<void> {
    const createClient =
      dependencies.createClient ??
      ((options: CodexProcessOptions) => new CodexJsonRpcClient(options))
    const createAdapter =
      dependencies.createAdapter ??
      ((client: RuntimeCodexClient) =>
        new CodexAppServerAdapter(client as CodexJsonRpcClient))
    const client = createClient({
      command: "codex",
      args: ["app-server"],
      cwd: config.workspace,
    })
    startingClient = client
    const adapter = createAdapter(client)
    let starting = true
    let exitedDuringStart = false
    const unsubscribe = client.subscribe((event) => {
      if (closing) return
      if (event.type === "request_failure") {
        if (
          starting ||
          event.method !== "turn/start" ||
          !event.recoverable
        ) {
          return
        }
        retireCurrentClient("request", true)
        return
      }
      if (event.type !== "exit") return
      if (starting) {
        exitedDuringStart = true
        return
      }
      retireCurrentClient("exit", false)
    })

    function retireCurrentClient(
      failure: "exit" | "request",
      stopClient: boolean
    ): void {
      if (client !== currentClient || closing) return
      unsubscribe()
      currentClient = undefined
      currentExitUnsubscribe = undefined
      if (restartBudget <= 0) {
        adapterProxy.makeUnavailable("app_server_not_started")
        health =
          failure === "exit" ? repeatedExitHealth() : repeatedRequestFailureHealth()
        if (stopClient) {
          trackRestart(client.stop().catch(() => {}))
        }
        return
      }
      restartBudget -= 1
      adapterProxy.beginReplacement("app_server_not_started")
      health = { status: "ok" }
      trackRestart(restartClient(failure, stopClient ? client : undefined))
    }
    try {
      await client.start(CLIENT_INFO)
      if (exitedDuringStart || closing) throw new Error("app_server_exited")
    } catch (error) {
      unsubscribe()
      adapter.dispose?.()
      await client.stop().catch(() => {})
      if (startingClient === client) startingClient = undefined
      throw error
    }
    starting = false
    startingClient = undefined
    if (closing) {
      unsubscribe()
      adapter.dispose?.()
      await client.stop().catch(() => {})
      throw new Error("app_server_stopped")
    }
    currentClient = client
    currentExitUnsubscribe = unsubscribe
    adapterProxy.replace(adapter)
    if (recovery) awaitingRecoveryCompletion = true
  }

  function trackRestart(pendingRestart: Promise<void>): void {
    restartPromise = pendingRestart
    void pendingRestart.finally(() => {
      if (restartPromise === pendingRestart) restartPromise = undefined
    })
  }

  async function restartClient(
    failure: "exit" | "request",
    retiredClient?: RuntimeCodexClient
  ): Promise<void> {
    try {
      await retiredClient?.stop().catch(() => {})
      if (closing) return
      await startClient(true)
      if (!closing) health = { status: "ok" }
    } catch {
      if (!closing) {
        adapterProxy.makeUnavailable("app_server_not_started")
        health =
          failure === "exit" ? repeatedExitHealth() : repeatedRequestFailureHealth()
      }
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    closing = true
    shutdownPromise = (async () => {
      if (sigintRegistered) {
        sigintRegistered = false
        await bestEffort(() => signals.off("SIGINT", onSignal))
      }
      if (sigtermRegistered) {
        sigtermRegistered = false
        await bestEffort(() => signals.off("SIGTERM", onSignal))
      }
      await bestEffort(() => currentExitUnsubscribe?.())
      currentExitUnsubscribe = undefined
      await bestEffort(() => unsubscribeRestartEvents())
      const appClose = bestEffort(() => app?.close())
      await bestEffort(() => service?.handleClientDisconnect())
      await bestEffort(() => adapterProxy.dispose())
      const clients = new Set(
        [currentClient, startingClient].filter(
          (client): client is RuntimeCodexClient => client !== undefined
        )
      )
      currentClient = undefined
      for (const client of clients) {
        await bestEffort(() => client.stop())
      }
      await bestEffort(() => restartPromise)
      startingClient = undefined
      await appClose
      await bestEffort(() => closeFrontend?.())
      if (!databaseClosed) {
        databaseClosed = true
        await bestEffort(() => database.close())
      }
    })()
    return shutdownPromise
  }

  try {
    repository = new ConversationRepository(database)
    repository.interruptRunning()
    const diagnose = dependencies.diagnose ?? diagnoseCodex
    const diagnostic = await diagnose("codex")
    if (diagnostic.status === "error") {
      health = { status: "degraded", error: diagnostic.error }
      adapterProxy.makeUnavailable(diagnostic.error.code)
    } else {
      try {
        await startClient(false)
      } catch (error) {
        const mapped = handshakeDiagnostic(error)
        if (!mapped) throw error
        health = { status: "degraded", error: mapped.error }
        adapterProxy.makeUnavailable(mapped.error.code)
      }
    }

    service = new ConversationService({
      repository,
      adapter: adapterProxy,
      eventSink: eventHub,
      workspace: config.workspace,
    })
    app = await buildApp({
      config,
      service,
      eventHub,
      health: () => health,
      deferReady: true,
    })
    const configureFrontend =
      dependencies.configureFrontend ?? configureTaskMuxFrontend
    closeFrontend = await configureFrontend(app, config.dev)
    const listen =
      dependencies.listen ?? ((instance, options) => instance.listen(options))
    const address = await listen(app, {
      host: "127.0.0.1",
      port: config.port,
    })
    if (closing) throw new Error("taskmux_stopped")
    signals.on("SIGINT", onSignal)
    sigintRegistered = true
    signals.on("SIGTERM", onSignal)
    sigtermRegistered = true

    return {
      app,
      service,
      repository,
      eventHub,
      address,
      health: () => health,
      shutdown,
    }
  } catch (error) {
    await shutdown()
    throw error
  }
}

function handshakeDiagnostic(
  error: unknown
): Extract<CodexDiagnostic, { status: "error" }> | null {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (
    message === "app_server_request_timeout" ||
    message === "invalid_initialize_response"
  ) {
    return diagnosticError(
      "codex_version_unsupported",
      "This Codex CLI version does not support app-server."
    ) as Extract<CodexDiagnostic, { status: "error" }>
  }
  if (
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("not authenticated") ||
    message.includes("login")
  ) {
    return diagnosticError(
      "codex_not_authenticated",
      "Codex CLI is not authenticated. Run codex login and try again."
    ) as Extract<CodexDiagnostic, { status: "error" }>
  }
  return null
}

async function bestEffort(
  operation: () => void | undefined | Promise<void>
): Promise<void> {
  try {
    await operation()
  } catch {
    // Cleanup continues so later owned resources are still released.
  }
}

function repeatedExitHealth(): AppHealth {
  return {
    status: "degraded",
    error: {
      code: "app_server_exited",
      message: "Agent service exited repeatedly. Restart TaskMux to try again.",
    },
  }
}

function repeatedRequestFailureHealth(): AppHealth {
  return {
    status: "degraded",
    error: {
      code: "codex_request_failed",
      message: "Agent service failed repeatedly. Restart TaskMux to try again.",
    },
  }
}

export type ViteMiddlewareServer = {
  middlewares: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    next: (error?: unknown) => void
  ) => void
  close(): Promise<void>
}

export async function configureTaskMuxFrontend(
  app: FastifyInstance,
  dev: boolean,
  dependencies: {
    createViteServer?: () => Promise<ViteMiddlewareServer>
    staticRoot?: string
  } = {}
): Promise<void | (() => Promise<void>)> {
  const apiNotFound = async (_request: unknown, reply: import("fastify").FastifyReply) =>
    reply.code(404).send({
      error: { code: "route_not_found", message: "Route not found." },
    })
  app.all("/api", apiNotFound)
  app.all("/api/*", apiNotFound)

  if (dev) {
    const [{ default: middie }, viteModule] = await Promise.all([
      import("@fastify/middie"),
      import("vite"),
    ])
    const vite = dependencies.createViteServer
      ? await dependencies.createViteServer()
      : await viteModule.createServer({
          server: { middlewareMode: true },
          appType: "spa",
        })
    try {
      await app.register(middie)
      app.use((request, response, next) => {
        if (isApiUrl(request.url ?? "")) {
          next()
          return
        }
        vite.middlewares(request, response, next)
      })
    } catch (error) {
      await vite.close().catch(() => {})
      throw error
    }
    return async () => vite.close()
  }

  const { default: fastifyStatic } = await import("@fastify/static")
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  await app.register(fastifyStatic, {
    root:
      dependencies.staticRoot ?? resolve(moduleDirectory, "../../dist/client"),
    wildcard: false,
  })
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"))
}

function isApiUrl(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = parseServerConfig(process.argv.slice(2), process.env)
  await startTaskMux(config)
}
