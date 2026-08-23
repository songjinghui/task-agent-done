import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  ConversationDetail,
  ConversationSummary,
} from "../shared/contracts.js"
import { App } from "./App.js"
import type { TaskMuxApi } from "./api.js"

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

afterEach(cleanup)

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
    expect(screen.queryByRole("article")).not.toBeInTheDocument()
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
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
