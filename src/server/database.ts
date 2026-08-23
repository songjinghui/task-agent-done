import { DatabaseSync } from "node:sqlite"

type Migration = {
  version: number
  sql: string
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE conversation (
        id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('idle','running','failed','interrupted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
]

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA journal_mode = WAL")
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const findMigration = database.prepare(
    "SELECT version FROM schema_migration WHERE version = ?"
  )
  const recordMigration = database.prepare(
    "INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)"
  )

  for (const migration of migrations) {
    if (findMigration.get(migration.version) !== undefined) {
      continue
    }

    database.exec("BEGIN")
    try {
      database.exec(migration.sql)
      recordMigration.run(migration.version, new Date().toISOString())
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  return database
}
