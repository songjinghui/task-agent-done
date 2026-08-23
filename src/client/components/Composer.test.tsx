import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskMuxApiError } from "../api.js"
import { Composer } from "./Composer.js"

afterEach(cleanup)

describe("Composer", () => {
  it("sends with Enter, keeps Shift+Enter as a newline, and clears only after success", async () => {
    const accepted = deferred<void>()
    const onSend = vi.fn(() => accepted.promise)
    const user = userEvent.setup()
    render(
      <Composer globallyLocked={false} active={false} onSend={onSend} onCancel={vi.fn()} />
    )
    const input = screen.getByRole("textbox", { name: "消息" })

    await user.type(input, "第一行{shift>}{enter}{/shift}第二行")
    expect(input).toHaveValue("第一行\n第二行")
    await user.type(input, "{enter}")

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith("第一行\n第二行")
    expect(input).toHaveValue("第一行\n第二行")
    accepted.resolve()
    expect(await screen.findByText("消息已发送")).toBeInTheDocument()
    expect(input).toHaveValue("")
  })

  it.each([
    new TaskMuxApiError("turn_conflict", "server detail must stay hidden", 409),
    new Error("transport detail must stay hidden"),
  ])("preserves the draft and shows a safe error when sending fails", async (failure) => {
    const user = userEvent.setup()
    render(
      <Composer
        globallyLocked={false}
        active={false}
        onSend={async () => {
          throw failure
        }}
        onCancel={vi.fn()}
      />
    )
    const input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "请保留我{enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败，请重试。")
    expect(screen.getByRole("alert")).not.toHaveTextContent(failure.message)
    expect(input).toHaveValue("请保留我")
  })

  it("rejects blank or more than 100,000 Unicode code points and honors the global lock", async () => {
    const onSend = vi.fn(async () => {})
    const view = render(
      <Composer globallyLocked={false} active={false} onSend={onSend} onCancel={vi.fn()} />
    )
    const input = screen.getByRole("textbox", { name: "消息" })
    const send = screen.getByRole("button", { name: "发送" })

    fireEvent.change(input, { target: { value: "   \n" } })
    expect(send).toBeDisabled()
    fireEvent.change(input, { target: { value: "😀".repeat(100_001) } })
    expect(send).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent("消息过长")

    view.rerender(
      <Composer globallyLocked active={false} onSend={onSend} onCancel={vi.fn()} />
    )
    fireEvent.change(input, { target: { value: "可以发送" } })
    expect(send).toBeDisabled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("shows cancel only for the selected active conversation and makes clicks idempotent", async () => {
    const cancellation = deferred<void>()
    const onCancel = vi.fn(() => cancellation.promise)
    const user = userEvent.setup()
    const view = render(
      <Composer globallyLocked active={false} onSend={vi.fn()} onCancel={onCancel} />
    )
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()

    view.rerender(
      <Composer globallyLocked active onSend={vi.fn()} onCancel={onCancel} />
    )
    const cancel = screen.getByRole("button", { name: "取消" })
    await user.dblClick(cancel)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(cancel).toBeDisabled()
    cancellation.resolve()
    await waitFor(() => expect(cancel).toHaveTextContent("取消"))
    expect(cancel).toBeEnabled()
  })
})

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
