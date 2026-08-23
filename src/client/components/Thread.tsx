import type { ReactNode } from "react"
import type {
  ConversationDetail,
  ConversationSummary,
} from "../../shared/contracts.js"

export function Thread({
  conversation,
  detail,
  loading,
  unavailable,
}: {
  conversation: ConversationSummary | null
  detail: ConversationDetail | null
  loading: boolean
  unavailable: boolean
}): ReactNode {
  if (!conversation) {
    return (
      <main className="thread thread-empty" aria-labelledby="thread-title">
        <div className="empty-card">
          <p className="eyebrow">纯文本工作台</p>
          <h2 id="thread-title">准备开始</h2>
          <p>新建一个会话开始工作。</p>
        </div>
      </main>
    )
  }

  const completedTurns =
    detail?.turns.filter((turn) => turn.status === "completed") ?? []

  return (
    <main className="thread" aria-labelledby="thread-title">
      <header className="thread-header">
        <p className="eyebrow">已完成历史</p>
        <h2 id="thread-title">{conversation.title}</h2>
      </header>

      {loading && !detail ? (
        <p className="thread-state" role="status">
          正在加载历史…
        </p>
      ) : unavailable && !detail ? (
        <p className="thread-state">暂时无法显示此会话的历史。</p>
      ) : completedTurns.length === 0 ? (
        <p className="thread-state">还没有已完成的消息。</p>
      ) : (
        <section className="message-list" aria-label="已完成的会话历史">
          {completedTurns.map((turn) => (
            <article
              className={`message message-${turn.role}`}
              aria-label={turn.role === "user" ? "用户消息" : "Assistant 消息"}
              key={turn.id}
            >
              <div className="message-role">
                {turn.role === "user" ? "用户" : "Assistant"}
              </div>
              <div className="message-text">{turn.text}</div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
