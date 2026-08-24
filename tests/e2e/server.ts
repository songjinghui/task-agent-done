import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test as base } from "@playwright/test"
import { CodexJsonRpcClient } from "../../src/server/codex/json-rpc-client.js"
import {
  startTaskMux,
  type RunningTaskMux,
  type RuntimeSignalSource,
} from "../../src/server/main.js"

const fakeServer = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url)
)

class IsolatedSignals implements RuntimeSignalSource {
  on(): void {}
  off(): void {}
}

export type E2eTaskMux = {
  readonly address: string
  readonly clientStarts: number
  readonly readyClientStarts: number
  readonly dataDir: string
  readonly workspace: string
  restartService(): Promise<void>
  stop(): Promise<void>
}

async function createE2eTaskMux(): Promise<E2eTaskMux> {
  const root = mkdtempSync(join(tmpdir(), "taskmux-e2e-"))
  const workspace = mkdtempSync(join(root, "workspace-"))
  const dataDir = mkdtempSync(join(root, "data-"))

  let running: RunningTaskMux | undefined
  let starts = 0
  let readyStarts = 0

  const start = async () => {
    running = await startTaskMux(
      {
        workspace,
        dataDir,
        dev: true,
        host: "127.0.0.1",
        port: 0,
      },
      {
        diagnose: async () => ({ status: "ok" }),
        createClient: ({ cwd }) => {
          starts += 1
          const client = new CodexJsonRpcClient({
            command: process.execPath,
            args: [fakeServer],
            cwd,
          })
          const startClient = client.start.bind(client)
          client.start = async (clientInfo) => {
            await startClient(clientInfo)
            readyStarts += 1
          }
          return client
        },
        signals: new IsolatedSignals(),
      }
    )
  }

  try {
    await start()
  } catch (error) {
    await running?.shutdown().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  return {
    get address() {
      if (!running) throw new Error("e2e_runtime_not_started")
      return running.address
    },
    get clientStarts() {
      return starts
    },
    get readyClientStarts() {
      return readyStarts
    },
    dataDir,
    workspace,
    async restartService() {
      await running?.shutdown()
      running = undefined
      await start()
    },
    async stop() {
      try {
        await running?.shutdown()
      } finally {
        running = undefined
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

export const test = base.extend<{ taskmux: E2eTaskMux }>({
  taskmux: async ({}, use) => {
    const taskmux = await createE2eTaskMux()
    try {
      await use(taskmux)
    } finally {
      await taskmux.stop()
    }
  },
})

export { expect } from "@playwright/test"
