import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"

const MAX_MESSAGE_CODE_POINTS = 100_000

export function Composer({
  globallyLocked,
  active,
  onSend,
  onCancel,
}: {
  globallyLocked: boolean
  active: boolean
  onSend(text: string): Promise<void>
  onCancel(): Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const sendInFlight = useRef(false)
  const cancelInFlight = useRef(false)
  const length = [...draft].length
  const tooLong = length > MAX_MESSAGE_CODE_POINTS
  const canSend =
    draft.trim().length > 0 &&
    !tooLong &&
    !globallyLocked &&
    !sendInFlight.current

  const submit = async (): Promise<void> => {
    if (!canSend) return
    sendInFlight.current = true
    setSending(true)
    setError(null)
    setAnnouncement("")
    try {
      await onSend(draft)
      setDraft("")
      setAnnouncement("消息已发送")
    } catch {
      setError("发送失败，请重试。")
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (cancelInFlight.current) return
    cancelInFlight.current = true
    setCancelling(true)
    setError(null)
    try {
      await onCancel()
    } catch {
      setError("取消失败，请重试。")
    } finally {
      cancelInFlight.current = false
      setCancelling(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void submit()
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
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby="composer-status"
      />
      <div className="composer-actions">
        <span
          id="composer-status"
          role={tooLong || announcement ? "status" : undefined}
          aria-live="polite"
        >
          {tooLong
            ? `消息过长（${length.toLocaleString()} / ${MAX_MESSAGE_CODE_POINTS.toLocaleString()}）`
            : announcement}
        </span>
        {active ? (
          <button type="button" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? "正在取消…" : "取消"}
          </button>
        ) : null}
        <button type="submit" disabled={!canSend || sending}>
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}
