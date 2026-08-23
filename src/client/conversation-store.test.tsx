import "@testing-library/jest-dom/vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import type {
  ConversationDetail,
  ConversationSummary,
} from "../shared/contracts.js"
import type { TaskMuxApi } from "./api.js"
import {
  ConversationProvider,
  useConversations,
} from "./conversation-store.js"

const first: ConversationSummary = {
  id: "c1",
  title: "第一个会话",
  status: "idle",
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:10:00.000Z",
}

const second: ConversationSummary = {
  id: "c2",
  title: "第二个会话",
  status: "interrupted",
  createdAt: "2026-08-23T09:00:00.000Z",
  updatedAt: "2026-08-23T09:10:00.000Z",
}

afterEach(cleanup)

describe("ConversationProvider", () => {
  it("normalizes the loaded summaries, preserves their order, and selects the first", async () => {
    const api = fakeApi({
      listConversations: async () => [second, first],
      getConversation: async (id) => detail(id, `${id} history`),
    })

    renderStore(api)

    expect(screen.getByTestId("list-loading")).toHaveTextContent("yes")
    expect(await screen.findByTestId("workspace")).toHaveTextContent(
      "/work/taskmux"
    )
    expect(await screen.findByTestId("selected-id")).toHaveTextContent("c2")
    expect(screen.getByTestId("ordered-ids")).toHaveTextContent("c2,c1")
    expect(screen.getByTestId("summary-titles")).toHaveTextContent(
      "第二个会话,第一个会话"
    )
    expect(await screen.findByTestId("selected-text")).toHaveTextContent(
      "c2 history"
    )
  })

  it("settles into an empty unselected state when no conversations exist", async () => {
    renderStore(fakeApi())

    expect(await screen.findByTestId("list-loading")).toHaveTextContent("no")
    expect(screen.getByTestId("ordered-ids")).toBeEmptyDOMElement()
    expect(screen.getByTestId("selected-id")).toBeEmptyDOMElement()
    expect(screen.getByTestId("selected-text")).toBeEmptyDOMElement()
  })

  it("creates, selects, and loads a new conversation", async () => {
    const api = fakeApi({
      createConversation: async () => first,
      getConversation: async (id) => detail(id, "新会话历史"),
    })
    const user = userEvent.setup()
    renderStore(api)
    await screen.findByText("ready")

    await user.click(screen.getByRole("button", { name: "create" }))

    expect(await screen.findByTestId("selected-id")).toHaveTextContent("c1")
    expect(screen.getByTestId("ordered-ids")).toHaveTextContent("c1")
    expect(await screen.findByTestId("selected-text")).toHaveTextContent(
      "新会话历史"
    )
  })

  it("exposes create loading and keeps the current selection after create fails", async () => {
    const create = deferred<ConversationSummary>()
    const api = fakeApi({
      listConversations: async () => [first],
      getConversation: async (id) => detail(id, "保留的历史"),
      createConversation: () => create.promise,
    })
    const user = userEvent.setup()
    renderStore(api)
    await screen.findByText("保留的历史")

    await user.click(screen.getByRole("button", { name: "create" }))
    expect(screen.getByTestId("create-loading")).toHaveTextContent("yes")

    await act(async () => {
      create.reject(new Error("暂时无法新建"))
      await create.promise.catch(() => {})
    })

    expect(screen.getByTestId("create-loading")).toHaveTextContent("no")
    expect(screen.getByTestId("selected-id")).toHaveTextContent("c1")
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法新建")
  })

  it("ignores an old detail success after the selection changes", async () => {
    const oldDetail = deferred<ConversationDetail>()
    const api = fakeApi({
      listConversations: async () => [first, second],
      getConversation: (id) =>
        id === first.id ? oldDetail.promise : Promise.resolve(detail(id, "当前历史")),
    })
    const user = userEvent.setup()
    renderStore(api)
    await screen.findByTestId("select-c2")

    await user.click(screen.getByTestId("select-c2"))
    expect(await screen.findByTestId("selected-text")).toHaveTextContent(
      "当前历史"
    )

    await act(async () => {
      oldDetail.resolve(detail(first.id, "过期历史"))
      await oldDetail.promise
    })

    expect(screen.getByTestId("selected-id")).toHaveTextContent("c2")
    expect(screen.getByTestId("selected-text")).toHaveTextContent("当前历史")
    expect(screen.getByTestId("known-details")).not.toHaveTextContent("c1")
  })

  it("ignores an old detail error after the selection changes", async () => {
    const oldDetail = deferred<ConversationDetail>()
    const api = fakeApi({
      listConversations: async () => [first, second],
      getConversation: (id) =>
        id === first.id ? oldDetail.promise : Promise.resolve(detail(id, "当前历史")),
    })
    const user = userEvent.setup()
    renderStore(api)
    await screen.findByTestId("select-c2")

    await user.click(screen.getByTestId("select-c2"))
    await screen.findByText("当前历史")

    await act(async () => {
      oldDetail.reject(new Error("过期错误"))
      await oldDetail.promise.catch(() => {})
    })

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByTestId("selected-id")).toHaveTextContent("c2")
    expect(screen.getByTestId("selected-text")).toHaveTextContent("当前历史")
  })

  it("surfaces a current detail failure without retaining its loading state", async () => {
    const api = fakeApi({
      listConversations: async () => [first],
      getConversation: async () => {
        throw new Error("历史暂不可用")
      },
    })
    renderStore(api)

    expect(await screen.findByRole("alert")).toHaveTextContent("历史暂不可用")
    expect(screen.getByTestId("detail-loading")).toHaveTextContent("no")
    expect(screen.getByTestId("selected-id")).toHaveTextContent("c1")
  })
})

function renderStore(api: TaskMuxApi): void {
  render(
    <ConversationProvider api={api}>
      <StoreProbe />
    </ConversationProvider>
  )
}

function StoreProbe(): ReactNode {
  const { state, conversations, selectedDetail, createConversation, select } =
    useConversations()

  return (
    <div>
      <div data-testid="workspace">{state.workspace ?? ""}</div>
      <div data-testid="list-loading">{state.loading.list ? "yes" : "no"}</div>
      <div data-testid="create-loading">
        {state.loading.create ? "yes" : "no"}
      </div>
      <div data-testid="detail-loading">
        {state.loading.detail ? "yes" : "no"}
      </div>
      <div data-testid="ordered-ids">{state.order.join(",")}</div>
      <div data-testid="summary-titles">
        {conversations.map((conversation) => conversation.title).join(",")}
      </div>
      <div data-testid="selected-id">{state.selectedId ?? ""}</div>
      <div data-testid="selected-text">
        {selectedDetail?.turns.map((turn) => turn.text).join(",") ?? ""}
      </div>
      <div data-testid="known-details">
        {Object.keys(state.detailsById).join(",")}
      </div>
      {state.error ? <div role="alert">{state.error}</div> : null}
      {!state.loading.list ? <span>ready</span> : null}
      <button type="button" onClick={() => void createConversation()}>
        create
      </button>
      <button type="button" data-testid="select-c2" onClick={() => select("c2")}>
        select c2
      </button>
    </div>
  )
}

function fakeApi(overrides: Partial<TaskMuxApi> = {}): TaskMuxApi {
  return {
    getHealth: async () => ({ status: "ok" }),
    getWorkspace: async () => ({ workspace: "/work/taskmux" }),
    listConversations: async () => [],
    createConversation: async () => first,
    getConversation: async (id) => detail(id, ""),
    sendMessage: async () => ({ accepted: true }),
    cancelConversation: async () => {},
    respondToApproval: async () => {},
    ...overrides,
  }
}

function detail(conversationId: string, text: string): ConversationDetail {
  return {
    conversationId,
    turns: text
      ? [
          {
            id: `${conversationId}-turn-1`,
            role: "assistant",
            text,
            status: "completed",
          },
        ]
      : [],
  }
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
