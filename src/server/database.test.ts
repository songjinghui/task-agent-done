import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase } from "./database.js"

const databaseDirectories: string[] = []

afterEach(() => {
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-database-"))
  databaseDirectories.push(directory)
  return join(directory, "taskmux.sqlite")
}

describe("openDatabase", () => {
  it("runs SQLite tests with only the experimental warning category suppressed", () => {
    expect(process.execArgv).toContain("--disable-warning=ExperimentalWarning")
    expect(process.execArgv).not.toContain("--no-warnings")
  })

  it("applies the initial migration only once and enables required pragmas", () => {
    const path = createDatabasePath()
    const first = openDatabase(path)

    expect(first.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(
      first.prepare("SELECT version FROM schema_migration ORDER BY version").all()
    ).toEqual([{ version: 1 }])
    first.close()

    const second = openDatabase(path)
    expect(
      second.prepare("SELECT version FROM schema_migration ORDER BY version").all()
    ).toEqual([{ version: 1 }])
    second.close()
  })
})
