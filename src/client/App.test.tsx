import "@testing-library/jest-dom/vitest"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ConversationDetail,
  ConversationSummary,
} from "../shared/contracts.js"
import { App } from "./App.js"
import { TaskMuxApiError, type TaskMuxApi } from "./api.js"

const first: ConversationSummary = {
  id: "c1",
  title: "修复 README 测试",
  status: "idle",
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:10:00.000Z",
}

const second: ConversationSummary = {
  id: "c2",
  title: "第二个会话",
  status: "running",
  createdAt: "2026-08-23T09:00:00.000Z",
  updatedAt: "2026-08-23T09:10:00.000Z",
}

beforeEach(() => {
  FakeEventSource.instances = []
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("App", () => {
  it("shows loading before rendering the workspace and conversation navigation", async () => {
    const list = deferred<ConversationSummary[]>()
    render(<App api={fakeApi({ listConversations: () => list.promise })} />)

    expect(screen.getByRole("status")).toHaveTextContent("正在加载会话")
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled()

    list.resolve([first])

    expect(await screen.findByText("/work/taskmux")).toBeVisible()
    expect(screen.getByRole("navigation", { name: "会话列表" })).toBeVisible()
    expect(
      screen.getByRole("button", { name: /修复 README 测试/ })
    ).toHaveAttribute("aria-current", "page")
  })

  it("renders status and time, switches selection, and shows history in source order", async () => {
    const api = fakeApi({
      listConversations: async () => [first, second],
      getConversation: async (id) =>
        id === first.id
          ? detail(first.id, [
              turn("u1", "user", "先问"),
              turn("a1", "assistant", "先答"),
            ])
          : detail(second.id, [
              turn("u2", "user", "历史问题"),
              turn("a2", "assistant", "历史回答"),
            ]),
    })
    const user = userEvent.setup()
    render(<App api={api} />)

    const firstButton = await screen.findByRole("button", {
      name: /修复 README 测试/,
    })
    const secondButton = screen.getByRole("button", { name: /第二个会话/ })
    expect(firstButton).toHaveAttribute("aria-current", "page")
    expect(firstButton).toHaveTextContent("待命")
    expect(secondButton).toHaveTextContent("运行中")
    expect(within(secondButton).getByText("2026-08-23 09:10").tagName).toBe(
      "TIME"
    )
    expect(within(secondButton).getByText("2026-08-23 09:10")).toHaveAttribute(
      "datetime",
      second.updatedAt
    )

    await user.click(secondButton)

    expect(secondButton).toHaveAttribute("aria-current", "page")
    expect(firstButton).not.toHaveAttribute("aria-current")
    expect(await screen.findByText("历史回答")).toBeVisible()
    const articles = screen.getAllByRole("article")
    expect(articles).toHaveLength(2)
    expect(articles.map((article) => article.textContent)).toEqual([
      "用户历史问题",
      "Assistant历史回答",
    ])
  })

  it("renders only completed history and keeps message content as literal text", async () => {
    const api = fakeApi({
      listConversations: async () => [first],
      getConversation: async () =>
        detail(first.id, [
          turn("u1", "user", "第一行\n第二行"),
          turn("failed", "assistant", "不应出现", "failed"),
          turn("interrupted", "assistant", "也不应出现", "interrupted"),
          turn("a1", "assistant", "<strong>不要加粗</strong>"),
        ]),
    })
    render(<App api={api} />)

    const multiline = await screen.findByText("第一行 第二行")
    expect(multiline.textContent).toBe("第一行\n第二行")
    const literal = screen.getByText("<strong>不要加粗</strong>")
    expect(literal).toBeVisible()
    expect(literal.querySelector("strong")).toBeNull()
    expect(screen.queryByText("不应出现")).not.toBeInTheDocument()
    expect(screen.queryByText("也不应出现")).not.toBeInTheDocument()
    expect(screen.getAllByRole("article")).toHaveLength(2)
    expect(screen.getByRole("main")).toContainElement(literal)
  })

  it("shows an actionable empty state", async () => {
    render(<App api={fakeApi()} />)

    expect(await screen.findByText("还没有会话")).toBeVisible()
    expect(screen.getByText("新建一个会话开始工作。")).toBeVisible()
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled()
  })

  it("creates a conversation once, selects it, and loads its empty history", async () => {
    const created: ConversationSummary = {
      ...first,
      id: "new",
      title: "新会话",
    }
    const createConversation = vi.fn(async () => created)
    const api = fakeApi({
      createConversation,
      getConversation: async (id) => detail(id, []),
    })
    const user = userEvent.setup()
    render(<App api={api} />)
    await screen.findByText("还没有会话")

    await user.click(screen.getByRole("button", { name: "新建会话" }))

    expect(createConversation).toHaveBeenCalledOnce()
    expect(
      await screen.findByRole("button", { name: /新会话/ })
    ).toHaveAttribute("aria-current", "page")
    expect(await screen.findByText("还没有已完成的消息。")).toBeVisible()
  })

  it("reports list and current-history failures without rendering unavailable data", async () => {
    const listError = fakeApi({
      listConversations: async () => {
        throw new Error("无法加载会话列表")
      },
    })
    const firstRender = render(<App api={listError} />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载会话列表"
    )
    expect(screen.queryByRole("article")).not.toBeInTheDocument()
    firstRender.unmount()

    const detailError = fakeApi({
      listConversations: async () => [first],
      getConversation: async () => {
        throw new Error("历史暂不可用")
      },
    })
    render(<App api={detailError} />)

    expect(await screen.findByRole("alert")).toHaveTextContent("历史暂不可用")
    expect(screen.getByText("暂时无法显示此会话的历史。")).toBeVisible()
    expect(screen.queryByText("还没有已完成的消息。")).not.toBeInTheDocument()
    expect(screen.queryByRole("article")).not.toBeInTheDocument()
  })

  it("retries failed history explicitly and renders the successful response", async () => {
    let attempts = 0
    const api = fakeApi({
      listConversations: async () => [first],
      getConversation: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("历史暂不可用")
        return detail(first.id, [turn("a1", "assistant", "重试后的历史")])
      },
    })
    const user = userEvent.setup()
    render(<App api={api} />)

    expect(await screen.findByRole("alert")).toHaveTextContent("历史暂不可用")
    expect(screen.queryByText("还没有已完成的消息。")).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: /修复 README 测试/ })
    )
    expect(screen.getByRole("alert")).toHaveTextContent("历史暂不可用")
    expect(screen.queryByText("还没有已完成的消息。")).not.toBeInTheDocument()
    expect(attempts).toBe(1)

    await user.click(screen.getByRole("button", { name: "重试" }))

    expect(await screen.findByText("重试后的历史")).toBeVisible()
    expect(attempts).toBe(2)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the selected detail error and retry visible when recovery list succeeds", async () => {
    installEventSource()
    const recoveryDetail = deferred<ConversationDetail>()
    let detailCalls = 0
    let listCalls = 0
    render(
      <App
        api={fakeApi({
          listConversations: async () => {
            listCalls += 1
            return [first]
          },
          getConversation: async () => {
            detailCalls += 1
            if (detailCalls === 1) throw new Error("历史独立失败")
            return recoveryDetail.promise
          },
        })}
      />
    )
    expect(await screen.findByRole("alert")).toHaveTextContent("历史独立失败")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.fail()
      source.open()
    })

    await waitFor(() => expect(listCalls).toBe(2))
    expect(detailCalls).toBe(2)
    expect(screen.getByRole("alert")).toHaveTextContent("历史独立失败")
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible()

    recoveryDetail.resolve(detail(first.id, []))
    await act(async () => void (await recoveryDetail.promise))
    expect(screen.queryByText("历史独立失败")).not.toBeInTheDocument()
  })

  it("ignores a late retry result after switching conversations", async () => {
    const retry = deferred<ConversationDetail>()
    let firstAttempts = 0
    const api = fakeApi({
      listConversations: async () => [first, second],
      getConversation: async (id) => {
        if (id === second.id) {
          return detail(second.id, [
            turn("a2", "assistant", "当前会话历史"),
          ])
        }
        firstAttempts += 1
        if (firstAttempts === 1) throw new Error("历史暂不可用")
        return retry.promise
      },
    })
    const user = userEvent.setup()
    render(<App api={api} />)
    await screen.findByRole("alert")

    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(screen.getByRole("status")).toHaveTextContent("正在加载历史")
    expect(screen.queryByText("还没有已完成的消息。")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    expect(await screen.findByText("当前会话历史")).toBeVisible()

    await act(async () => {
      retry.resolve(
        detail(first.id, [turn("late", "assistant", "迟到的重试历史")])
      )
      await retry.promise
    })

    expect(screen.queryByText("迟到的重试历史")).not.toBeInTheDocument()
    expect(screen.getByText("当前会话历史")).toBeVisible()
    expect(
      screen.getByRole("button", { name: /第二个会话/ })
    ).toHaveAttribute("aria-current", "page")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("recovers from a create failure without losing the empty workspace", async () => {
    const api = fakeApi({
      createConversation: async () => {
        throw new Error("新建失败")
      },
    })
    const user = userEvent.setup()
    render(<App api={api} />)
    await screen.findByText("还没有会话")

    await user.click(screen.getByRole("button", { name: "新建会话" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("新建失败")
    expect(screen.getByText("还没有会话")).toBeVisible()
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled()
  })

  it("renders live text, safe tools and approvals, then keeps completed text once", async () => {
    installEventSource()
    const respondToApproval = vi.fn(async () => {})
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          respondToApproval,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!

    act(() => {
      source.open()
      source.event(1, first.id, { type: "turn_started", turnId: "t1" })
      source.event(2, first.id, {
        type: "text_delta",
        turnId: "t1",
        text: "实时回答",
      })
      source.event(3, first.id, {
        type: "tool_status",
        tool: {
          id: "tool-1",
          label: "unknown /secret/path command output",
          status: "running",
        },
      })
      source.event(4, first.id, {
        type: "approval_requested",
        request: {
          id: "approval-1",
          kind: "command",
          label: "rm -rf /secret/path",
        },
      })
    })

    expect(screen.getByText("实时回答")).toBeVisible()
    expect(screen.getByRole("status", { name: "使用工具：运行中" })).toBeVisible()
    expect(
      screen.getByRole("group", { name: "Codex 请求运行命令" })
    ).toBeVisible()
    expect(document.body).not.toHaveTextContent("/secret/path")
    expect(screen.getByRole("button", { name: "取消" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "批准" }))
    expect(respondToApproval).toHaveBeenCalledWith(
      first.id,
      "approval-1",
      "accept"
    )
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Codex 请求运行命令" })).not.toBeInTheDocument()
    )

    act(() => {
      source.event(5, first.id, { type: "turn_completed", turnId: "t1" })
    })
    expect(screen.getAllByText("实时回答")).toHaveLength(1)
    expect(screen.queryByRole("status", { name: /使用工具/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()
  })

  it("keeps an HTTP-accepted send locked until its SSE terminal event", async () => {
    installEventSource()
    const accepted = deferred<{ accepted: true }>()
    const sendMessage = vi.fn(() => accepted.promise)
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          sendMessage,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const input = screen.getByRole("textbox", { name: "消息" })

    await user.type(input, "执行测试{enter}")
    expect(sendMessage).toHaveBeenCalledWith(first.id, "执行测试", "send-1")
    expect(input).toHaveValue("执行测试")
    expect(screen.getByText("执行测试", { selector: ".message-text" })).toBeVisible()

    accepted.resolve({ accepted: true })
    await waitFor(() => expect(input).toHaveValue(""))
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled()

    const source = FakeEventSource.instances[0]!
    act(() => {
      source.event(
        1,
        first.id,
        { type: "turn_started", turnId: "t1" },
        "send-1"
      )
      source.event(
        2,
        first.id,
        { type: "turn_completed", turnId: "t1" },
        "send-1"
      )
    })
    await user.type(input, "下一条")
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled()
  })

  it("preserves a conflict draft and removes its unaccepted optimistic message", async () => {
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          sendMessage: async () => {
            throw new TaskMuxApiError("turn_conflict", "sensitive conflict", 409)
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const input = screen.getByRole("textbox", { name: "消息" })

    await user.type(input, "冲突草稿{enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败，请重试。")
    expect(screen.getByRole("alert")).not.toHaveTextContent("sensitive conflict")
    expect(input).toHaveValue("冲突草稿")
    expect(
      screen.queryByText("冲突草稿", { selector: ".message-text" })
    ).not.toBeInTheDocument()
  })

  it("keeps an SSE-accepted optimistic message when the HTTP transport response is lost", async () => {
    installEventSource()
    const response = deferred<{ accepted: true }>()
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          sendMessage: () => response.promise,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "响应丢失{enter}")
    act(() => {
      FakeEventSource.instances[0]!.event(
        1,
        first.id,
        {
          type: "turn_started",
          turnId: "t1",
        },
        "send-1"
      )
    })
    response.reject(new Error("provider transport secret"))

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败，请重试。")
    expect(input).toHaveValue("响应丢失")
    expect(screen.getByText("响应丢失", { selector: ".message-text" })).toBeVisible()
    expect(screen.getByRole("button", { name: "取消" })).toBeVisible()
  })

  it("applies the global running lock but only cancels the selected active conversation", async () => {
    const cancelConversation = vi.fn(async () => {})
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first, second],
          cancelConversation,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "被全局锁阻止")
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    expect(await screen.findByRole("button", { name: "取消" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(cancelConversation).toHaveBeenCalledOnce()
    expect(cancelConversation).toHaveBeenCalledWith(second.id)

    await user.click(screen.getByRole("button", { name: /修复 README 测试/ }))
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()
  })

  it("allows a new turn to start a second cancel while the retired cancel HTTP call is pending", async () => {
    installEventSource()
    const firstCancel = deferred<void>()
    const secondCancel = deferred<void>()
    const cancelConversation = vi
      .fn<(conversationId: string) => Promise<void>>()
      .mockImplementationOnce(() => firstCancel.promise)
      .mockImplementationOnce(() => secondCancel.promise)
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          cancelConversation,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.event(1, first.id, { type: "turn_started", turnId: "turn-one" })
    })
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(cancelConversation).toHaveBeenCalledTimes(1)

    act(() => {
      source.event(2, first.id, {
        type: "turn_interrupted",
        turnId: "turn-one",
      })
      source.event(3, first.id, { type: "turn_started", turnId: "turn-two" })
    })
    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(cancelConversation).toHaveBeenCalledTimes(2)

    firstCancel.resolve()
    await act(async () => void (await firstCancel.promise))
    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled()

    secondCancel.resolve()
    await act(async () => void (await secondCancel.promise))
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled()
  })

  it("shows the EventSource reconnect state without creating another connection", async () => {
    installEventSource()
    render(<App api={fakeApi()} />)
    await screen.findByText("还没有会话")
    const source = FakeEventSource.instances[0]!

    act(() => source.fail())
    expect(screen.getByRole("status", { name: "事件流状态" })).toHaveTextContent(
      "实时连接已断开，正在重连…"
    )
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => source.open())
    expect(screen.queryByRole("status", { name: "事件流状态" })).not.toBeInTheDocument()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it("finishes bootstrap from recovery workspace and list when reopen cancels the first load", async () => {
    installEventSource()
    const firstWorkspace = deferred<{ workspace: string }>()
    const firstList = deferred<ConversationSummary[]>()
    let workspaceCalls = 0
    let listCalls = 0
    render(
      <App
        api={fakeApi({
          getWorkspace: () => {
            workspaceCalls += 1
            return workspaceCalls === 1
              ? firstWorkspace.promise
              : Promise.resolve({ workspace: "/recovered/workspace" })
          },
          listConversations: () => {
            listCalls += 1
            return listCalls === 1
              ? firstList.promise
              : Promise.resolve([first])
          },
        })}
      />
    )
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.fail()
      source.open()
    })

    expect(await screen.findByText("/recovered/workspace")).toBeVisible()
    expect(screen.getByRole("button", { name: /修复 README 测试/ })).toBeVisible()
    expect(screen.queryByText("正在加载会话…")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled()
    expect(workspaceCalls).toBe(2)
    expect(listCalls).toBe(2)

    firstWorkspace.resolve({ workspace: "/stale/workspace" })
    firstList.resolve([])
    await act(async () => {
      await firstWorkspace.promise
      await firstList.promise
    })
    expect(screen.getByText("/recovered/workspace")).toBeVisible()
    expect(screen.getByRole("button", { name: /修复 README 测试/ })).toBeVisible()
  })

  it("keeps a pre-reconnect create result while recovery is pending and merges the stale snapshot", async () => {
    installEventSource()
    const create = deferred<ConversationSummary>()
    const recoveryList = deferred<ConversationSummary[]>()
    let listCalls = 0
    const created = { ...first, id: "local-new", title: "重连前新建" }
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: () => {
            listCalls += 1
            return listCalls === 1 ? Promise.resolve([]) : recoveryList.promise
          },
          createConversation: () => create.promise,
          getConversation: async (id) => detail(id, []),
        })}
      />
    )
    await screen.findByText("还没有会话")
    await user.click(screen.getByRole("button", { name: "新建会话" }))
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.fail()
      source.open()
    })
    await waitFor(() => expect(listCalls).toBe(2))

    create.resolve(created)
    expect(
      await screen.findByRole("button", { name: /重连前新建/ })
    ).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled()

    recoveryList.resolve([{ ...created, title: "过期的新建快照" }])
    await act(async () => void (await recoveryList.promise))
    expect(screen.getByRole("button", { name: /重连前新建/ })).toBeVisible()
    expect(screen.queryByText("过期的新建快照")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled()
  })

  it("keeps drafts and send settlement scoped to their conversation", async () => {
    const idleSecond = { ...second, status: "idle" as const }
    const accepted = deferred<{ accepted: true }>()
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first, idleSecond],
          sendMessage: () => accepted.promise,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    let input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "A 草稿{enter}")

    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "B 草稿")
    accepted.resolve({ accepted: true })
    await waitFor(() => expect(input).toHaveValue("B 草稿"))

    await user.click(screen.getByRole("button", { name: /修复 README 测试/ }))
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("")
    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("B 草稿")
  })

  it("does not erase text added after a submitted draft snapshot", async () => {
    const accepted = deferred<{ accepted: true }>()
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          sendMessage: () => accepted.promise,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "已提交{enter}")
    await user.type(input, " 后来输入")

    accepted.resolve({ accepted: true })
    await waitFor(() => expect(input).toHaveValue("已提交 后来输入"))
  })

  it("keeps a rejected send error with conversation A while viewing conversation B", async () => {
    const idleSecond = { ...second, status: "idle" as const }
    const response = deferred<{ accepted: true }>()
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first, idleSecond],
          sendMessage: () => response.promise,
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    await user.type(screen.getByRole("textbox", { name: "消息" }), "A 失败{enter}")
    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    response.reject(new Error("provider raw secret"))

    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    )
    await user.click(screen.getByRole("button", { name: /修复 README 测试/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败，请重试。")
    expect(screen.getByRole("alert")).not.toHaveTextContent("provider raw secret")
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("A 失败")
  })

  it("keeps an HTTP approval-expired error visible after clearing the request", async () => {
    installEventSource()
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          respondToApproval: async () => {
            throw new TaskMuxApiError(
              "approval_expired",
              "raw provider approval detail",
              409
            )
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    act(() => {
      FakeEventSource.instances[0]!.event(1, first.id, {
        type: "approval_requested",
        request: { id: "a-expired", kind: "command", label: "secret" },
      })
    })
    await user.click(screen.getByRole("button", { name: "批准" }))

    expect(
      await screen.findByText("审批请求已失效。", { selector: "[role=alert]" })
    ).toBeVisible()
    expect(screen.queryByRole("group", { name: "Codex 请求运行命令" })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("raw provider approval detail")
  })

  it("recovers missed terminal history after reopen without duplicate transient turns", async () => {
    installEventSource()
    let listCalls = 0
    let detailCalls = 0
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => {
            listCalls += 1
            return [first]
          },
          getConversation: async () => {
            detailCalls += 1
            return detail(
              first.id,
              detailCalls === 1
                ? []
                : [
                    turn("history-user", "user", "恢复问题"),
                    turn("history-assistant", "assistant", "恢复回答"),
                  ]
            )
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!
    await user.type(screen.getByRole("textbox", { name: "消息" }), "恢复问题{enter}")
    act(() => {
      source.open()
      source.event(80, first.id, { type: "turn_started", turnId: "live-turn" })
      source.event(81, first.id, {
        type: "text_delta",
        turnId: "live-turn",
        text: "恢复回答",
      })
      source.fail()
      source.open()
    })

    await waitFor(() => {
      expect(listCalls).toBe(2)
      expect(detailCalls).toBe(2)
    })
    expect(screen.getAllByText("恢复问题")).toHaveLength(1)
    expect(screen.getAllByText("恢复回答")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it("syncs a reconnect terminal by epoch identity after recovery detail succeeds but before list status", async () => {
    installEventSource()
    const recoveryList = deferred<ConversationSummary[]>()
    let listCalls = 0
    let detailCalls = 0
    render(
      <App
        api={fakeApi({
          listConversations: () => {
            listCalls += 1
            return listCalls === 1
              ? Promise.resolve([first])
              : recoveryList.promise
          },
          getConversation: async () => {
            detailCalls += 1
            return detail(
              first.id,
              detailCalls < 3
                ? []
                : [turn("recovered-history", "assistant", "终态后历史")]
            )
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.fail()
      source.open()
    })
    await waitFor(() => expect(detailCalls).toBe(2))
    expect(listCalls).toBe(2)

    act(() => {
      source.event(1, first.id, {
        type: "turn_completed",
        turnId: "reconnected-turn",
      })
    })
    expect(await screen.findByText("终态后历史")).toBeVisible()
    expect(detailCalls).toBe(3)

    act(() => {
      source.event(2, first.id, {
        type: "turn_completed",
        turnId: "reconnected-turn",
      })
    })
    await act(async () => {})
    expect(detailCalls).toBe(3)

    recoveryList.resolve([{ ...first, status: "running" }])
    await act(async () => void (await recoveryList.promise))
    expect(screen.getByText("终态后历史")).toBeVisible()
    expect(
      screen.getByRole("button", { name: /修复 README 测试/ })
    ).toHaveTextContent("待命")
  })

  it("supersedes pre-terminal detail and syncs selected completed history without cross-ID duplicates", async () => {
    installEventSource()
    const preTerminalDetail = deferred<ConversationDetail>()
    const sendResponse = deferred<{ accepted: true }>()
    let detailCalls = 0
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          getConversation: async () => {
            detailCalls += 1
            if (detailCalls === 1) return preTerminalDetail.promise
            return detail(first.id, [
              turn("codex-user", "user", "同步问题"),
              turn("codex-assistant", "assistant", "同步回答"),
            ])
          },
          sendMessage: () => sendResponse.promise,
        })}
      />
    )
    await screen.findByRole("button", { name: /修复 README 测试/ })
    await user.type(screen.getByRole("textbox", { name: "消息" }), "同步问题{enter}")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.event(
        1,
        first.id,
        { type: "turn_started", turnId: "live-turn" },
        "send-1"
      )
      source.event(
        2,
        first.id,
        { type: "text_delta", turnId: "live-turn", text: "同步回答" },
        "send-1"
      )
      source.event(
        3,
        first.id,
        { type: "turn_completed", turnId: "live-turn" },
        "send-1"
      )
    })

    await waitFor(() => expect(detailCalls).toBe(2))
    expect(
      screen.getAllByText("同步问题", { selector: ".message-text" })
    ).toHaveLength(1)
    expect(
      screen.getAllByText("同步回答", { selector: ".message-text" })
    ).toHaveLength(1)
    expect(
      screen.queryByRole("button", { name: "取消" })
    ).not.toBeInTheDocument()

    preTerminalDetail.resolve(
      detail(first.id, [turn("stale", "assistant", "终态前旧历史")])
    )
    await act(async () => void (await preTerminalDetail.promise))
    expect(screen.queryByText("终态前旧历史")).not.toBeInTheDocument()
    expect(
      screen.getAllByText("同步问题", { selector: ".message-text" })
    ).toHaveLength(1)
    expect(
      screen.getAllByText("同步回答", { selector: ".message-text" })
    ).toHaveLength(1)

    sendResponse.resolve({ accepted: true })
    await act(async () => void (await sendResponse.promise))
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("")
  })

  it("keeps terminal transients when detail sync fails and retires them after retry", async () => {
    installEventSource()
    let detailCalls = 0
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          getConversation: async () => {
            detailCalls += 1
            if (detailCalls === 1) return detail(first.id, [])
            if (detailCalls === 2) throw new Error("终态历史同步失败")
            return detail(first.id, [
              turn("retry-user", "user", "保留问题"),
              turn("retry-assistant", "assistant", "保留回答"),
            ])
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    await user.type(screen.getByRole("textbox", { name: "消息" }), "保留问题{enter}")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.event(
        1,
        first.id,
        { type: "turn_started", turnId: "retry-turn" },
        "send-1"
      )
      source.event(
        2,
        first.id,
        { type: "text_delta", turnId: "retry-turn", text: "保留回答" },
        "send-1"
      )
      source.event(
        3,
        first.id,
        { type: "turn_completed", turnId: "retry-turn" },
        "send-1"
      )
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("终态历史同步失败")
    expect(
      screen.getAllByText("保留问题", { selector: ".message-text" })
    ).toHaveLength(1)
    expect(
      screen.getAllByText("保留回答", { selector: ".message-text" })
    ).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: "重试" }))
    await waitFor(() => expect(detailCalls).toBe(3))
    expect(screen.queryByText("终态历史同步失败")).not.toBeInTheDocument()
    expect(
      screen.getAllByText("保留问题", { selector: ".message-text" })
    ).toHaveLength(1)
    expect(
      screen.getAllByText("保留回答", { selector: ".message-text" })
    ).toHaveLength(1)
  })

  it("ignores stale recovery detail after selection changes and refreshes unselected status", async () => {
    installEventSource()
    const recoveryDetail = deferred<ConversationDetail>()
    let firstDetailCalls = 0
    let listCalls = 0
    const recoveredFirst = { ...first, status: "failed" as const }
    const recoveredSecond = { ...second, status: "interrupted" as const }
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => {
            listCalls += 1
            return listCalls === 1 ? [first, second] : [recoveredFirst, recoveredSecond]
          },
          getConversation: (id) => {
            if (id === second.id) {
              return Promise.resolve(detail(second.id, [turn("b", "assistant", "B 历史")]))
            }
            firstDetailCalls += 1
            return firstDetailCalls === 1
              ? Promise.resolve(detail(first.id, []))
              : recoveryDetail.promise
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!
    act(() => {
      source.open()
      source.fail()
      source.open()
    })
    await waitFor(() => expect(firstDetailCalls).toBe(2))
    await user.click(screen.getByRole("button", { name: /第二个会话/ }))
    expect(await screen.findByText("B 历史")).toBeVisible()

    recoveryDetail.resolve(detail(first.id, [turn("late", "assistant", "迟到恢复")]))
    await act(async () => void (await recoveryDetail.promise))
    expect(screen.queryByText("迟到恢复")).not.toBeInTheDocument()
    expect(screen.getByText("B 历史")).toBeVisible()
    expect(screen.getByRole("button", { name: /修复 README 测试/ })).toHaveTextContent("失败")
    expect(screen.getByRole("button", { name: /第二个会话/ })).toHaveTextContent("已中断")
  })

  it("retires pre-reconnect request ownership so an old settlement cannot block or clear a new send", async () => {
    installEventSource()
    const oldResponse = deferred<{ accepted: true }>()
    let sendCalls = 0
    const user = userEvent.setup()
    render(
      <App
        api={fakeApi({
          listConversations: async () => [first],
          sendMessage: () => {
            sendCalls += 1
            return sendCalls === 1
              ? oldResponse.promise
              : Promise.resolve({ accepted: true })
          },
        })}
      />
    )
    await screen.findByText("还没有已完成的消息。")
    const source = FakeEventSource.instances[0]!
    const input = screen.getByRole("textbox", { name: "消息" })
    await user.type(input, "旧请求{enter}")
    act(() => {
      source.open()
      source.fail()
      source.open()
    })
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "事件流状态" })).not.toBeInTheDocument()
    )
    await user.clear(input)
    await user.type(input, "新请求{enter}")

    expect(sendCalls).toBe(2)
    await waitFor(() => expect(input).toHaveValue(""))
    oldResponse.resolve({ accepted: true })
    await act(async () => void (await oldResponse.promise))
    expect(input).toHaveValue("")
  })
})

function fakeApi(overrides: Partial<TaskMuxApi> = {}): TaskMuxApi {
  return {
    getHealth: async () => ({ status: "ok" }),
    getWorkspace: async () => ({ workspace: "/work/taskmux" }),
    listConversations: async () => [],
    createConversation: async () => first,
    getConversation: async (id) => detail(id, []),
    sendMessage: async () => ({ accepted: true }),
    cancelConversation: async () => {},
    respondToApproval: async () => {},
    ...overrides,
  }
}

function detail(
  conversationId: string,
  turns: ConversationDetail["turns"]
): ConversationDetail {
  return { conversationId, turns }
}

function turn(
  id: string,
  role: "user" | "assistant",
  text: string,
  status: "completed" | "interrupted" | "failed" = "completed"
): ConversationDetail["turns"][number] {
  return { id, role, text, status }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installEventSource(): void {
  vi.stubGlobal("EventSource", FakeEventSource)
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this)
  }

  open(): void {
    this.onopen?.()
  }

  fail(): void {
    this.onerror?.()
  }

  event(
    seq: number,
    conversationId: string,
    payload: import("../shared/contracts.js").ConversationEvent,
    clientRequestId?: string
  ): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ conversationId, seq, payload, clientRequestId }),
      })
    )
  }

  close(): void {}
}
