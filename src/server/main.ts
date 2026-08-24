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
  const repository = new ConversationRepository(database)
  repository.interruptRunning()
  const eventHub = new EventHub()
  const adapterProxy = new ReplaceableAgentAdapter()

  let health: AppHealth = { status: "ok" }
  let currentClient: RuntimeCodexClient | undefined
  let currentExitUnsubscribe: (() => void) | undefined
  let restartBudget = 1
  let awaitingRecoveryCompletion = false
  let closing = false
  let shutdownPromise: Promise<void> | undefined

  adapterProxy.observeEvents((event) => {
    if (awaitingRecoveryCompletion && event.payload.type === "turn_completed") {
      restartBudget = 1
      awaitingRecoveryCompletion = false
      health = { status: "ok" }
    }
  })

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
      health = { status: "degraded", error: mapped.error }
      adapterProxy.makeUnavailable(mapped.error.code)
    }
  }

  const service = new ConversationService({
    repository,
    adapter: adapterProxy,
    eventSink: eventHub,
    workspace: config.workspace,
  })

  const app = await buildApp({
    config,
    service,
    eventHub,
    health: () => health,
    deferReady: true,
  })
  const configureFrontend =
    dependencies.configureFrontend ?? configureTaskMuxFrontend
  const closeFrontend = await configureFrontend(app, config.dev)
  const listen =
    dependencies.listen ?? ((instance, options) => instance.listen(options))
  const address = await listen(app, { host: "127.0.0.1", port: config.port })
  const signals = dependencies.signals ?? process

  const onSignal = () => {
    void shutdown()
  }
  signals.on("SIGINT", onSignal)
  signals.on("SIGTERM", onSignal)

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
    const adapter = createAdapter(client)
    let starting = true
    let exitedDuringStart = false
    const unsubscribe = client.subscribe((event) => {
      if (event.type !== "exit" || closing) return
      if (starting) {
        exitedDuringStart = true
        return
      }
      if (client !== currentClient) return
      unsubscribe()
      currentClient = undefined
      currentExitUnsubscribe = undefined
      adapterProxy.makeUnavailable("app_server_not_started")
      if (restartBudget <= 0) {
        health = repeatedExitHealth()
        return
      }
      restartBudget -= 1
      void restartClient()
    })
    try {
      await client.start(CLIENT_INFO)
      if (exitedDuringStart || closing) throw new Error("app_server_exited")
    } catch (error) {
      unsubscribe()
      await client.stop().catch(() => {})
      throw error
    }
    starting = false
    currentClient = client
    currentExitUnsubscribe = unsubscribe
    adapterProxy.replace(adapter)
    if (recovery) awaitingRecoveryCompletion = true
  }

  async function restartClient(): Promise<void> {
    try {
      await startClient(true)
      health = { status: "ok" }
    } catch {
      health = repeatedExitHealth()
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    closing = true
    signals.off("SIGINT", onSignal)
    signals.off("SIGTERM", onSignal)
    shutdownPromise = (async () => {
      await app.close()
      try {
        await service.handleClientDisconnect()
      } catch {
        // Continue shutting down even when interrupt delivery fails.
      }
      currentExitUnsubscribe?.()
      await currentClient?.stop()
      await closeFrontend?.()
      database.close()
    })()
    return shutdownPromise
  }

  return {
    app,
    service,
    repository,
    eventHub,
    address,
    health: () => health,
    shutdown,
  }
}

function handshakeDiagnostic(
  error: unknown
): Extract<CodexDiagnostic, { status: "error" }> {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
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
  return diagnosticError(
    "codex_version_unsupported",
    "Codex app-server could not be initialized. Update Codex CLI and try again."
  ) as Extract<CodexDiagnostic, { status: "error" }>
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
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !isApiUrl(request.url)) {
      if (!dev) return reply.sendFile("index.html")
    }
    return reply.code(404).send({
      error: { code: "route_not_found", message: "Route not found." },
    })
  })

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
    await app.register(middie)
    app.use(vite.middlewares)
    return async () => vite.close()
  }

  const { default: fastifyStatic } = await import("@fastify/static")
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  await app.register(fastifyStatic, {
    root:
      dependencies.staticRoot ?? resolve(moduleDirectory, "../../dist/client"),
    wildcard: false,
  })
}

function isApiUrl(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = parseServerConfig(process.argv.slice(2), process.env)
  await startTaskMux(config)
}
