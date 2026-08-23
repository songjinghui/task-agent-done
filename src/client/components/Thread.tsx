import type { ReactNode } from "react"
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConversationDetail,
  ConversationSummary,
  MessageTurn,
  ToolStatus,
} from "../../shared/contracts.js"
import { ApprovalBar } from "./ApprovalBar.js"
import { Composer } from "./Composer.js"
import { ToolLine } from "./ToolLine.js"

export function Thread({
  conversation,
  detail,
  loading,
  unavailable,
  turns,
  liveText,
  tools,
  approval,
  approvalError,
  liveError,
  draft,
  sending,
  cancelling,
  sendError,
  cancelError,
  globallyLocked,
  active,
  onSend,
  onDraftChange,
  onCancel,
  onApproval,
}: {
  conversation: ConversationSummary | null
  detail: ConversationDetail | null
  loading: boolean
  unavailable: boolean
  turns: MessageTurn[]
  liveText: string
  tools: ToolStatus[]
  approval: ApprovalRequest | null
  approvalError: string | null
  liveError: string | null
  draft: string
  sending: boolean
  cancelling: boolean
  sendError: string | null
  cancelError: string | null
  globallyLocked: boolean
  active: boolean
  onDraftChange(draft: string): void
  onSend(): Promise<void>
  onCancel(): Promise<void>
  onApproval(decision: ApprovalDecision): Promise<void>
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

  const hasMessages = turns.length > 0 || liveText.length > 0

  return (
    <main className="thread" aria-labelledby="thread-title">
      <header className="thread-header">
        <p className="eyebrow">已完成历史</p>
        <h2 id="thread-title">{conversation.title}</h2>
      </header>

      {loading && !detail && !hasMessages ? (
        <p className="thread-state" role="status">
          正在加载历史…
        </p>
      ) : unavailable && !detail && !hasMessages ? (
        <p className="thread-state">暂时无法显示此会话的历史。</p>
      ) : !hasMessages ? (
        <p className="thread-state">还没有已完成的消息。</p>
      ) : (
        <section className="message-list" aria-label="会话消息">
          {turns.map((turn) => (
            <Message key={turn.id} turn={turn} />
          ))}
          {liveText ? (
            <Message
              turn={{
                id: "live-assistant",
                role: "assistant",
                text: liveText,
                status: "completed",
              }}
            />
          ) : null}
        </section>
      )}

      {tools.length > 0 ? (
        <section className="tool-list" aria-label="工具状态">
          {tools.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
        </section>
      ) : null}
      <ApprovalBar
        request={approval}
        externalError={approvalError}
        onDecision={onApproval}
      />
      {liveError ? (
        <p className="turn-error" role="alert">
          {liveError}
        </p>
      ) : null}
      <Composer
        draft={draft}
        globallyLocked={globallyLocked}
        active={active}
        sending={sending}
        cancelling={cancelling}
        sendError={sendError}
        cancelError={cancelError}
        onDraftChange={onDraftChange}
        onSend={() => void onSend()}
        onCancel={() => void onCancel()}
      />
    </main>
  )
}

function Message({ turn }: { turn: MessageTurn }): ReactNode {
  return (
    <article
      className={`message message-${turn.role}`}
      aria-label={turn.role === "user" ? "用户消息" : "Assistant 消息"}
    >
      <div className="message-role">
        {turn.role === "user" ? "用户" : "Assistant"}
      </div>
      <div className="message-text">{turn.text}</div>
    </article>
  )
}
