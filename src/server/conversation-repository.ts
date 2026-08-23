import type { DatabaseSync } from "node:sqlite"
import type { ConversationStatus, ConversationSummary } from "../shared/contracts.js"

type ConversationRow = {
  id: string
  codex_thread_id: string
  title: string
  status: ConversationStatus
  created_at: string
  updated_at: string
}

export type StoredConversation = ConversationSummary & {
  externalSessionId: string
}

export type CreateConversationInput = {
  id: string
  externalSessionId: string
}

export class ConversationRepository {
  private readonly createStatement
  private readonly listStatement
  private readonly getByIdStatement
  private readonly getByExternalSessionIdStatement
  private readonly updateTitleStatement
  private readonly setStatusStatement
  private readonly interruptRunningStatement

  constructor(database: DatabaseSync) {
    this.createStatement = database.prepare(`
      INSERT INTO conversation (
        id, codex_thread_id, title, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.listStatement = database.prepare(`
      SELECT id, codex_thread_id, title, status, created_at, updated_at
      FROM conversation
      ORDER BY updated_at DESC
    `)
    this.getByIdStatement = database.prepare(`
      SELECT id, codex_thread_id, title, status, created_at, updated_at
      FROM conversation
      WHERE id = ?
    `)
    this.getByExternalSessionIdStatement = database.prepare(`
      SELECT id, codex_thread_id, title, status, created_at, updated_at
      FROM conversation
      WHERE codex_thread_id = ?
    `)
    this.updateTitleStatement = database.prepare(`
      UPDATE conversation
      SET title = ?, updated_at = ?
      WHERE id = ?
    `)
    this.setStatusStatement = database.prepare(`
      UPDATE conversation
      SET status = ?, updated_at = ?
      WHERE id = ?
    `)
    this.interruptRunningStatement = database.prepare(`
      UPDATE conversation
      SET status = 'interrupted', updated_at = ?
      WHERE status = 'running'
    `)
  }

  create(input: CreateConversationInput): StoredConversation {
    const timestamp = new Date().toISOString()
    this.createStatement.run(
      input.id,
      input.externalSessionId,
      "新会话",
      "idle",
      timestamp,
      timestamp
    )
    return {
      id: input.id,
      externalSessionId: input.externalSessionId,
      title: "新会话",
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  list(): StoredConversation[] {
    return this.listStatement.all().map((row) => this.toConversation(row))
  }

  getById(id: string): StoredConversation | null {
    return this.toConversationOrNull(this.getByIdStatement.get(id))
  }

  getByExternalSessionId(externalSessionId: string): StoredConversation | null {
    return this.toConversationOrNull(
      this.getByExternalSessionIdStatement.get(externalSessionId)
    )
  }

  updateTitle(id: string, title: string): void {
    this.updateTitleStatement.run(title, new Date().toISOString(), id)
  }

  setStatus(id: string, status: ConversationStatus): void {
    this.setStatusStatement.run(status, new Date().toISOString(), id)
  }

  interruptRunning(): number {
    const result = this.interruptRunningStatement.run(new Date().toISOString())
    return Number(result.changes)
  }

  private toConversationOrNull(row: unknown): StoredConversation | null {
    return row === undefined ? null : this.toConversation(row)
  }

  private toConversation(row: unknown): StoredConversation {
    const conversation = row as ConversationRow
    return {
      id: conversation.id,
      externalSessionId: conversation.codex_thread_id,
      title: conversation.title,
      status: conversation.status,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    }
  }
}
