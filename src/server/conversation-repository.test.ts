import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openDatabase } from "./database.js"
import { ConversationRepository } from "./conversation-repository.js"

const databaseDirectories: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createTestRepository(): ConversationRepository {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-repository-"))
  databaseDirectories.push(directory)
  const database = openDatabase(join(directory, "taskmux.sqlite"))
  databases.push(database)
  return new ConversationRepository(database)
}

describe("ConversationRepository", () => {
  it("creates, lists, and uniquely maps an external session", () => {
    const repo = createTestRepository()
    repo.create({ id: "c1", externalSessionId: "thr_1" })

    expect(repo.list()[0]).toMatchObject({
      id: "c1",
      externalSessionId: "thr_1",
      title: "新会话",
      status: "idle",
    })
    expect(repo.getByExternalSessionId("thr_1")?.id).toBe("c1")
    expect(() => repo.create({ id: "c2", externalSessionId: "thr_1" })).toThrow()
  })

  it("returns null for an unknown ID or external session", () => {
    const repo = createTestRepository()

    expect(repo.getById("missing")).toBeNull()
    expect(repo.getByExternalSessionId("missing")).toBeNull()
  })

  it("orders conversations by their most recent update", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"))
    const repo = createTestRepository()
    repo.create({ id: "older", externalSessionId: "thr_1" })
    vi.setSystemTime(new Date("2026-08-23T00:00:01.000Z"))
    repo.create({ id: "newer", externalSessionId: "thr_2" })

    expect(repo.list().map((conversation) => conversation.id)).toEqual([
      "newer",
      "older",
    ])
  })

  it("updates a title and status", () => {
    const repo = createTestRepository()
    repo.create({ id: "c1", externalSessionId: "thr_1" })

    repo.updateTitle("c1", "Release checklist")
    repo.setStatus("c1", "failed")

    expect(repo.getById("c1")).toMatchObject({
      title: "Release checklist",
      status: "failed",
    })
  })

  it("marks stale running rows interrupted at startup", () => {
    const repo = createTestRepository()
    repo.create({ id: "c1", externalSessionId: "thr_1" })
    repo.setStatus("c1", "running")

    expect(repo.interruptRunning()).toBe(1)
    expect(repo.getById("c1")?.status).toBe("interrupted")
    expect(repo.interruptRunning()).toBe(0)
  })
})
