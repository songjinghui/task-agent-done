import { describe, expect, it, vi } from "vitest"
import type { ConversationSummary } from "../shared/contracts.js"
import {
  createTaskMuxApi,
  TaskMuxApiError,
  type TaskMuxApi,
} from "./api.js"

const summary: ConversationSummary = {
  id: "conversation / 1",
  title: "修复 README 测试",
  status: "idle",
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:01:00.000Z",
}

describe("TaskMux API", () => {
  it("maps the workspace and conversation REST routes to typed results", async () => {
    const responses = [
      jsonResponse({ status: "ok" }),
      jsonResponse({ workspace: "/work/taskmux" }),
      jsonResponse([summary]),
      jsonResponse(summary, 201),
      jsonResponse({
        conversationId: summary.id,
        turns: [
          {
            id: "turn-1",
            role: "assistant",
            text: "历史回答",
            status: "completed",
          },
        ],
      }),
      jsonResponse({ accepted: true }, 202),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!)
    const api = createTaskMuxApi(fetcher)

    await expect(api.getHealth()).resolves.toEqual({ status: "ok" })
    await expect(api.getWorkspace()).resolves.toEqual({
      workspace: "/work/taskmux",
    })
    await expect(api.listConversations()).resolves.toEqual([summary])
    await expect(api.createConversation()).resolves.toEqual(summary)
    await expect(api.getConversation(summary.id)).resolves.toEqual({
      conversationId: summary.id,
      turns: [
        {
          id: "turn-1",
          role: "assistant",
          text: "历史回答",
          status: "completed",
        },
      ],
    })
    await expect(
      api.sendMessage(summary.id, "hello\nworld", "send-safe-1")
    ).resolves.toEqual({ accepted: true })
    await expect(api.cancelConversation(summary.id)).resolves.toBeUndefined()
    await expect(
      api.respondToApproval(summary.id, "approval / 1", "decline")
    ).resolves.toBeUndefined()

    expect(fetcher.mock.calls).toEqual([
      ["/api/health", undefined],
      ["/api/workspace", undefined],
      ["/api/conversations", undefined],
      ["/api/conversations", { method: "POST" }],
      ["/api/conversations/conversation%20%2F%201", undefined],
      [
        "/api/conversations/conversation%20%2F%201/messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "hello\nworld",
            clientRequestId: "send-safe-1",
          }),
        },
      ],
      [
        "/api/conversations/conversation%20%2F%201/cancel",
        { method: "POST" },
      ],
      [
        "/api/conversations/conversation%20%2F%201/approvals/approval%20%2F%201",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "decline" }),
        },
      ],
    ])
  })

  it("normalizes a structured non-success response", async () => {
    const api = createTaskMuxApi(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            error: {
              code: "conversation_not_found",
              message: "Conversation does not exist.",
            },
          },
          404
        )
      )
    )

    const error = await api.getConversation("missing").catch((value) => value)

    expect(error).toBeInstanceOf(TaskMuxApiError)
    expect(error).toMatchObject({
      code: "conversation_not_found",
      message: "Conversation does not exist.",
      status: 404,
    })
  })

  it("decodes a sanitized degraded health DTO from its expected 503 response", async () => {
    const api = createTaskMuxApi(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            status: "degraded",
            error: {
              code: "app_server_exited",
              message: "raw provider detail must be discarded",
              stderr: "secret stderr",
            },
          },
          503
        )
      )
    )

    await expect(api.getHealth()).resolves.toEqual({
      status: "degraded",
      error: {
        code: "app_server_exited",
        message: "raw provider detail must be discarded",
      },
    })
  })

  it("sanitizes valid DTOs instead of exposing unknown server fields", async () => {
    const api = createTaskMuxApi(
      sequenceFetcher([
        jsonResponse({
          status: "degraded",
          error: {
            code: "codex_not_authenticated",
            message: "Sign in required.",
            stderr: "provider diagnostic",
          },
          rawProvider: { method: "initialize" },
        }),
        jsonResponse([
          {
            ...summary,
            codexThreadId: "provider-thread-secret",
            rawProvider: { method: "thread/read" },
          },
        ]),
        jsonResponse({
          conversationId: summary.id,
          rawProvider: { threadId: "provider-thread-secret" },
          turns: [
            {
              id: "turn-1",
              role: "assistant",
              text: "历史回答",
              status: "completed",
              providerItem: { type: "agentMessage" },
            },
          ],
        }),
      ])
    )

    await expect(api.getHealth()).resolves.toEqual({
      status: "degraded",
      error: {
        code: "codex_not_authenticated",
        message: "Sign in required.",
      },
    })
    await expect(api.listConversations()).resolves.toEqual([summary])
    await expect(api.getConversation(summary.id)).resolves.toEqual({
      conversationId: summary.id,
      turns: [
        {
          id: "turn-1",
          role: "assistant",
          text: "历史回答",
          status: "completed",
        },
      ],
    })
  })

  it.each([
    {
      name: "non-JSON health",
      response: new Response("not-json", { status: 200 }),
      invoke: (api: TaskMuxApi) => api.getHealth(),
    },
    {
      name: "unknown health status",
      response: jsonResponse({ status: "starting" }),
      invoke: (api: TaskMuxApi) => api.getHealth(),
    },
    {
      name: "blank degraded health error",
      response: jsonResponse({
        status: "degraded",
        error: { code: "", message: " " },
      }),
      invoke: (api: TaskMuxApi) => api.getHealth(),
    },
    {
      name: "blank workspace",
      response: jsonResponse({ workspace: " " }),
      invoke: (api: TaskMuxApi) => api.getWorkspace(),
    },
    {
      name: "non-array list",
      response: jsonResponse({ conversations: [] }),
      invoke: (api: TaskMuxApi) => api.listConversations(),
    },
    {
      name: "invalid nested summary status",
      response: jsonResponse([{ ...summary, status: "waiting" }]),
      invoke: (api: TaskMuxApi) => api.listConversations(),
    },
    {
      name: "invalid nested summary date",
      response: jsonResponse([{ ...summary, updatedAt: "yesterday" }]),
      invoke: (api: TaskMuxApi) => api.listConversations(),
    },
    {
      name: "blank created conversation ID",
      response: jsonResponse({ ...summary, id: "" }, 201),
      invoke: (api: TaskMuxApi) => api.createConversation(),
    },
    {
      name: "blank created conversation title",
      response: jsonResponse({ ...summary, title: " " }, 201),
      invoke: (api: TaskMuxApi) => api.createConversation(),
    },
    {
      name: "mismatched detail conversation ID",
      response: jsonResponse({ conversationId: "other", turns: [] }),
      invoke: (api: TaskMuxApi) => api.getConversation(summary.id),
    },
    {
      name: "invalid nested turn role",
      response: jsonResponse({
        conversationId: summary.id,
        turns: [
          {
            id: "turn-1",
            role: "tool",
            text: "raw output",
            status: "completed",
          },
        ],
      }),
      invoke: (api: TaskMuxApi) => api.getConversation(summary.id),
    },
    {
      name: "blank nested turn ID",
      response: jsonResponse({
        conversationId: summary.id,
        turns: [
          {
            id: " ",
            role: "assistant",
            text: "history",
            status: "completed",
          },
        ],
      }),
      invoke: (api: TaskMuxApi) => api.getConversation(summary.id),
    },
    {
      name: "invalid nested turn status",
      response: jsonResponse({
        conversationId: summary.id,
        turns: [
          {
            id: "turn-1",
            role: "assistant",
            text: "partial",
            status: "running",
          },
        ],
      }),
      invoke: (api: TaskMuxApi) => api.getConversation(summary.id),
    },
    {
      name: "non-string nested turn text",
      response: jsonResponse({
        conversationId: summary.id,
        turns: [
          {
            id: "turn-1",
            role: "assistant",
            text: { raw: "history" },
            status: "completed",
          },
        ],
      }),
      invoke: (api: TaskMuxApi) => api.getConversation(summary.id),
    },
    {
      name: "unaccepted message response",
      response: jsonResponse({ accepted: false }, 202),
      invoke: (api: TaskMuxApi) => api.sendMessage(summary.id, "hello"),
    },
    {
      name: "non-204 cancel response",
      response: new Response("unexpected", { status: 200 }),
      invoke: (api: TaskMuxApi) => api.cancelConversation(summary.id),
    },
    {
      name: "non-204 approval response",
      response: new Response(null, { status: 200 }),
      invoke: (api: TaskMuxApi) =>
        api.respondToApproval(summary.id, "approval-1", "accept"),
    },
  ])("rejects malformed success: $name", async ({ response, invoke }) => {
    const api = createTaskMuxApi(vi.fn<typeof fetch>(async () => response))

    const error = await invoke(api).catch((value) => value)

    expect(error).toBeInstanceOf(TaskMuxApiError)
    expect(error).toMatchObject({
      code: "invalid_response",
      message: "Server returned an invalid response.",
      status: response.status,
    })
  })

  it.each([
    new Response("not-json", {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
    jsonResponse({ error: { code: 17, message: null } }, 503),
    jsonResponse({ error: { code: "", message: "   " } }, 503),
  ])("uses a safe fallback for a malformed error response", async (response) => {
    const api = createTaskMuxApi(vi.fn<typeof fetch>(async () => response))

    const error = await api.listConversations().catch((value) => value)

    expect(error).toBeInstanceOf(TaskMuxApiError)
    expect(error).toMatchObject({
      code: "request_failed",
      message: "Request failed with status 503.",
      status: 503,
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sequenceFetcher(responses: Response[]): typeof fetch {
  return vi.fn<typeof fetch>(async () => responses.shift()!)
}
