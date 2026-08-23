import type {
  FormEvent,
  KeyboardEvent,
  ReactNode,
} from "react"

const MAX_MESSAGE_CODE_POINTS = 100_000

export function Composer({
  draft,
  globallyLocked,
  active,
  sending,
  cancelling,
  sendError,
  cancelError = null,
  onDraftChange,
  onSend,
  onCancel,
}: {
  draft: string
  globallyLocked: boolean
  active: boolean
  sending: boolean
  cancelling: boolean
  sendError: string | null
  cancelError?: string | null
  onDraftChange(draft: string): void
  onSend(): void
  onCancel(): void
}): ReactNode {
  const length = [...draft].length
  const tooLong = length > MAX_MESSAGE_CODE_POINTS
  const canSend =
    draft.trim().length > 0 && !tooLong && !globallyLocked && !sending

  const submit = (): void => {
    if (canSend) onSend()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }
    event.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <label className="composer-label" htmlFor="message-composer">
        消息
      </label>
      <textarea
        id="message-composer"
        value={draft}
        rows={4}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby="composer-status"
      />
      <div className="composer-actions">
        <span
          id="composer-status"
          role={tooLong ? "status" : undefined}
          aria-live="polite"
        >
          {tooLong
            ? `消息过长（${length.toLocaleString()} / ${MAX_MESSAGE_CODE_POINTS.toLocaleString()}）`
            : ""}
        </span>
        {active ? (
          <button type="button" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "正在取消…" : "取消"}
          </button>
        ) : null}
        <button type="submit" disabled={!canSend}>
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
      {sendError ?? cancelError ? (
        <p role="alert">{sendError ?? cancelError}</p>
      ) : null}
    </form>
  )
}
