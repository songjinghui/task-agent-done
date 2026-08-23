import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./Composer.js"

afterEach(cleanup)

describe("Composer", () => {
  it("sends with Enter, keeps Shift+Enter as a newline, and ignores IME composition Enter", async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ComposerHarness onSend={onSend} />)
    const input = screen.getByRole("textbox", { name: "消息" })

    await user.type(input, "第一行{shift>}{enter}{/shift}第二行")
    expect(input).toHaveValue("第一行\n第二行")
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue("第一行\n第二行")

    await user.type(input, "{enter}")
    expect(onSend).toHaveBeenCalledOnce()
  })

  it("renders conversation-scoped safe send errors without raw details", () => {
    render(
      <ComposerHarness sendError="发送失败，请重试。" />
    )

    expect(screen.getByRole("alert")).toHaveTextContent("发送失败，请重试。")
    expect(screen.getByRole("alert")).not.toHaveTextContent("provider")
  })

  it("rejects blank or more than 100,000 Unicode code points and honors the global lock", () => {
    const onSend = vi.fn()
    const view = render(<ComposerHarness onSend={onSend} />)
    const input = screen.getByRole("textbox", { name: "消息" })
    const send = screen.getByRole("button", { name: "发送" })

    fireEvent.change(input, { target: { value: "   \n" } })
    expect(send).toBeDisabled()
    fireEvent.change(input, { target: { value: "😀".repeat(100_001) } })
    expect(send).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent("消息过长")

    view.rerender(<ComposerHarness globallyLocked onSend={onSend} />)
    fireEvent.change(input, { target: { value: "可以发送" } })
    expect(send).toBeDisabled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("shows cancel only for the selected active conversation and disables it while pending", async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const view = render(<ComposerHarness onCancel={onCancel} />)
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()

    view.rerender(<ComposerHarness active onCancel={onCancel} />)
    const cancel = screen.getByRole("button", { name: "取消" })
    await user.click(cancel)
    expect(onCancel).toHaveBeenCalledOnce()

    view.rerender(<ComposerHarness active cancelling onCancel={onCancel} />)
    expect(cancel).toBeDisabled()
    expect(cancel).toHaveTextContent("正在取消…")
  })
})

function ComposerHarness({
  globallyLocked = false,
  active = false,
  sending = false,
  cancelling = false,
  sendError = null,
  onSend = vi.fn(),
  onCancel = vi.fn(),
}: {
  globallyLocked?: boolean
  active?: boolean
  sending?: boolean
  cancelling?: boolean
  sendError?: string | null
  onSend?: () => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState("")
  return (
    <Composer
      draft={draft}
      globallyLocked={globallyLocked}
      active={active}
      sending={sending}
      cancelling={cancelling}
      sendError={sendError}
      onDraftChange={setDraft}
      onSend={onSend}
      onCancel={onCancel}
    />
  )
}
