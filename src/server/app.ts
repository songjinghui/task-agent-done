import Fastify, { type FastifyInstance, type FastifyReply } from "fastify"
import type { AgentAdapter } from "./agent/agent-adapter.js"
import type { ServerConfig } from "./config.js"
import type { ConversationRepository } from "./conversation-repository.js"
import { ConversationService } from "./conversation-service.js"
import { EventHub } from "./event-hub.js"
import {
  registerHttpRoutes,
  type AppHealth,
} from "./http-routes.js"

export type { AppHealth } from "./http-routes.js"

export type BuildAppOptions = {
  config: ServerConfig
  repository: ConversationRepository
  adapter: AgentAdapter
  eventHub?: EventHub
  health?: () => AppHealth
}

export async function buildApp(
  options: BuildAppOptions
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    frameworkErrors: (_error, _request, reply) =>
      (reply as FastifyReply).code(400).send({
        error: {
          code: "invalid_path_parameter",
          message: "Path parameter is invalid.",
        },
      }),
  })
  const eventHub = options.eventHub ?? new EventHub()
  const service = new ConversationService({
    repository: options.repository,
    adapter: options.adapter,
    eventSink: eventHub,
    workspace: options.config.workspace,
  })

  registerHttpRoutes(app, {
    workspace: options.config.workspace,
    service,
    eventHub,
    health: options.health ?? (() => ({ status: "ok" })),
  })
  await app.ready()
  return app
}
