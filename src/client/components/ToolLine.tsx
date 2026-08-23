import type { ReactNode } from "react"
import type { ToolStatus } from "../../shared/contracts.js"

export function ToolLine({ tool }: { tool: ToolStatus }): ReactNode {
  const category =
    tool.label === "运行命令"
      ? "运行命令"
      : tool.label === "修改文件"
        ? "修改文件"
        : "使用工具"
  const state = {
    running: { icon: "◌", label: "运行中" },
    completed: { icon: "✓", label: "完成" },
    failed: { icon: "✕", label: "失败" },
    declined: { icon: "✕", label: "已拒绝" },
  }[tool.status]
  const accessible = `${category}：${state.label}`

  return (
    <div className={`tool-line tool-${tool.status}`} role="status" aria-label={accessible}>
      <span aria-hidden="true">{state.icon}</span>
      <span>{category}</span>
      <span aria-hidden="true">：{state.label}</span>
    </div>
  )
}
