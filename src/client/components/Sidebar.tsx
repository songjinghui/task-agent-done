import type { ReactNode } from "react"
import type {
  ConversationStatus,
  ConversationSummary,
} from "../../shared/contracts.js"

export function Sidebar({
  workspace,
  conversations,
  selectedId,
  loading,
  creating,
  onCreate,
  onSelect,
}: {
  workspace: string | null
  conversations: ConversationSummary[]
  selectedId: string | null
  loading: boolean
  creating: boolean
  onCreate(): void
  onSelect(conversationId: string): void
}): ReactNode {
  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          T
        </span>
        <div>
          <h1>TaskMux</h1>
          <p className="workspace-path" title={workspace ?? undefined}>
            {workspace ?? "本地工作区"}
          </p>
        </div>
      </header>

      <button
        className="new-conversation"
        type="button"
        disabled={loading || creating}
        aria-busy={creating}
        onClick={onCreate}
      >
        <span aria-hidden="true">＋</span>
        {creating ? "正在新建…" : "新建会话"}
      </button>

      <nav className="conversation-nav" aria-label="会话列表">
        <div className="nav-heading">会话</div>
        {loading ? (
          <p className="sidebar-state" role="status">
            正在加载会话…
          </p>
        ) : conversations.length === 0 ? (
          <p className="sidebar-state">还没有会话</p>
        ) : (
          <ul className="conversation-list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  className="conversation-entry"
                  type="button"
                  aria-current={
                    conversation.id === selectedId ? "page" : undefined
                  }
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="conversation-title">
                    {conversation.title}
                  </span>
                  <span className="conversation-meta">
                    <span
                      className={`status status-${conversation.status}`}
                    >
                      {statusLabel(conversation.status)}
                    </span>
                    <time dateTime={conversation.updatedAt}>
                      {formatTime(conversation.updatedAt)}
                    </time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}

function statusLabel(status: ConversationStatus): string {
  return {
    idle: "待命",
    running: "运行中",
    failed: "失败",
    interrupted: "已中断",
  }[status]
}

function formatTime(timestamp: string): string {
  return timestamp.slice(0, 16).replace("T", " ")
}
