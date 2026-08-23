import { useEffect, useRef, useState, type ReactNode } from "react"
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../shared/contracts.js"

export function ApprovalBar({
  request,
  onDecision,
}: {
  request: ApprovalRequest | null
  onDecision(decision: ApprovalDecision): Promise<void>
}): ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clicked = useRef(false)

  useEffect(() => {
    clicked.current = false
    setPending(false)
    setError(null)
  }, [request?.id])

  if (!request) return null

  const label =
    request.kind === "command"
      ? "Codex 请求运行命令"
      : "Codex 请求修改文件"

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    if (clicked.current) return
    clicked.current = true
    setPending(true)
    setError(null)
    try {
      await onDecision(decision)
    } catch {
      setError("无法处理审批请求。")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="approval-bar" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="approval-actions">
        <button type="button" disabled={clicked.current || pending} onClick={() => void decide("accept")}>
          批准
        </button>
        <button type="button" disabled={clicked.current || pending} onClick={() => void decide("decline")}>
          拒绝
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
