import { describe, expect, it, vi } from "vitest"
import type {
  CodexClientInfo,
  CodexJsonRpcClientEvent,
  JsonRpcId,
} from "../src/server/codex/codex-types.js"
import {
  inspectSmokeSafetyEvent,
  runRealCodexSmoke,
  type SmokeClient,
} from "./smoke-real-codex-support.js"

describe("real Codex smoke safety", () => {
  it("best-effort declines every server request and fails without raw details", () => {
    const respond = vi.fn(() => {
      throw new Error("secret transport detail")
    })
    const event: CodexJsonRpcClientEvent = {
      type: "server_request",
      id: "request-secret-id",
      method: "unknown/interaction/with-secret",
      params: { token: "raw-secret" },
    }

    const failure = inspectSmokeSafetyEvent(event, respond)

    expect(respond).toHaveBeenCalledWith("request-secret-id", {
      decision: "decline",
    })
    expect(failure?.message).toBe("Real Codex smoke refused an interaction")
    expect(failure?.message).not.toContain("secret")
  })

  it.each(["message", "userMessage", "agentMessage", "reasoning"])(
    "allows the explicit %s item whitelist for start and completion",
    (type) => {
      for (const method of ["item/started", "item/completed"]) {
        expect(
          inspectSmokeSafetyEvent(
            {
              type: "notification",
              method,
              params: { item: { id: "safe", type } },
            },
            () => {}
          )
        ).toBeNull()
      }
    }
  )

  it.each(["commandExecution", "fileChange", "webSearch", "mcpToolCall", "unknown", undefined])(
    "fails closed for item type %s without exposing it",
    (type) => {
      const failure = inspectSmokeSafetyEvent(
        {
          type: "notification",
          method: "item/completed",
          params: { item: { id: "unsafe", ...(type ? { type } : {}) } },
        },
        () => {}
      )

      expect(failure?.message).toBe("Real Codex smoke refused an item")
      expect(failure?.message).not.toContain(String(type))
    }
  )
})

describe("real Codex smoke deadline", () => {
  it("shares one total budget across initialize, requests, completion, and stop", async () => {
    let now = 1_000
    const client = new FakeSmokeClient(() => {
      now += 10_000
    })

    await expect(
      runRealCodexSmoke(client, "/disposable", {
        now: () => now,
        timeoutMs: 60_000,
      })
    ).resolves.toBe("TASKMUX_SMOKE_OK")

    expect(client.timeouts).toEqual([60_000, 50_000, 40_000, 30_000])
  })

  it("reliably rejects the main wait when an unsafe event arrives", async () => {
    let now = 1_000
    const client = new FakeSmokeClient(
      () => {
        now += 10_000
      },
      "unsafe"
    )

    await expect(
      runRealCodexSmoke(client, "/disposable", {
        now: () => now,
        timeoutMs: 60_000,
      })
    ).rejects.toThrow("Real Codex smoke refused an item")
    expect(client.timeouts).toEqual([60_000, 50_000, 40_000, 30_000])
  })

  it("rejects an unsafe event even while a protocol request is pending", async () => {
    const client = new FakeSmokeClient(() => {}, "unsafe-during-thread")

    await expect(
      runRealCodexSmoke(client, "/disposable", { timeoutMs: 60_000 })
    ).rejects.toThrow("Real Codex smoke refused an item")
  })

  it("sanitizes protocol request failures", async () => {
    const client = new FakeSmokeClient(() => {}, "request-error")

    const failure = runRealCodexSmoke(client, "/disposable")

    await expect(failure).rejects.toThrow("Real Codex smoke failed")
    await expect(failure).rejects.not.toThrow("raw secret response")
  })
})

class FakeSmokeClient implements SmokeClient {
  readonly timeouts: number[] = []
  readonly #listeners = new Set<(event: CodexJsonRpcClientEvent) => void>()

  constructor(
    private readonly advance: () => void,
    private readonly result:
      | "completed"
      | "unsafe"
      | "unsafe-during-thread"
      | "request-error" = "completed"
  ) {}

  async start(_clientInfo: CodexClientInfo, timeoutMs: number): Promise<void> {
    this.timeouts.push(timeoutMs)
    this.advance()
  }

  async request<T>(method: string, _params: unknown, timeoutMs: number): Promise<T> {
    this.timeouts.push(timeoutMs)
    this.advance()
    if (method === "thread/start") {
      if (this.result === "request-error") {
        throw new Error("raw secret response")
      }
      if (this.result === "unsafe-during-thread") {
        queueMicrotask(() => {
          this.emit({
            type: "notification",
            method: "item/started",
            params: { item: { id: "unsafe", type: "mcpToolCall" } },
          })
        })
        return new Promise<T>(() => {})
      }
      return { thread: { id: "thread-1" } } as T
    }
    queueMicrotask(() => {
      if (this.result === "unsafe") {
        this.emit({
          type: "notification",
          method: "item/started",
          params: { item: { id: "unsafe", type: "webSearch" } },
        })
        return
      }
      this.emit({
        type: "notification",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "TASKMUX_SMOKE_OK" },
      })
      this.emit({
        type: "notification",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      })
    })
    return { turn: { id: "turn-1" } } as T
  }

  respond(_id: JsonRpcId, _result: unknown): void {}

  subscribe(listener: (event: CodexJsonRpcClientEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async stop(timeoutMs: number): Promise<void> {
    this.timeouts.push(timeoutMs)
  }

  private emit(event: CodexJsonRpcClientEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
