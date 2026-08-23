import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApprovalRequest } from "../../shared/contracts.js"
import { ApprovalBar } from "./ApprovalBar.js"

afterEach(cleanup)

describe("ApprovalBar", () => {
  it.each([
    ["command", "Codex 请求运行命令"],
    ["file_change", "Codex 请求修改文件"],
  ] as const)("uses fixed copy for %s and never renders provider detail", (kind, copy) => {
    const view = render(
      <ApprovalBar
        request={request(kind)}
        onDecision={async () => {}}
      />
    )

    expect(screen.getByRole("group", { name: copy })).toBeVisible()
    expect(view.container).not.toHaveTextContent("rm -rf")
    expect(view.container).not.toHaveTextContent("/secret/path")
  })

  it("disables both decisions synchronously after the first click", async () => {
    const decision = deferred<void>()
    const onDecision = vi.fn(() => decision.promise)
    const user = userEvent.setup()
    render(<ApprovalBar request={request("command")} onDecision={onDecision} />)
    const accept = screen.getByRole("button", { name: "批准" })
    const decline = screen.getByRole("button", { name: "拒绝" })

    await user.dblClick(accept)
    await user.click(decline)

    expect(onDecision).toHaveBeenCalledOnce()
    expect(onDecision).toHaveBeenCalledWith("accept")
    expect(accept).toBeDisabled()
    expect(decline).toBeDisabled()
  })

  it("shows a fixed safe failure and disappears when the request expires", async () => {
    const user = userEvent.setup()
    const view = render(
      <ApprovalBar
        request={request("file_change")}
        onDecision={async () => {
          throw new Error("secret command and provider diagnostic")
        }}
      />
    )
    await user.click(screen.getByRole("button", { name: "拒绝" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法处理审批请求。"
    )
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret command")

    view.rerender(<ApprovalBar request={null} onDecision={async () => {}} />)
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

function request(kind: ApprovalRequest["kind"]): ApprovalRequest {
  return {
    id: "approval-1",
    kind,
    label: "rm -rf /secret/path",
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
