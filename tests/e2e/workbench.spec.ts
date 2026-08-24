import type { Page } from "@playwright/test"
import { expect, test } from "./server.js"

async function createConversation(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新建会话" }).click()
  await expect(page.getByRole("heading", { name: "新会话" })).toBeVisible()
}

async function send(page: Page, prompt: string): Promise<void> {
  await page.getByRole("textbox", { name: "消息" }).fill(prompt)
  await page.getByRole("button", { name: "发送" }).click()
}

test("creates a conversation, streams text and restores the resumed history after refresh", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "hello from e2e")

  await expect(page.getByLabel("用户消息")).toContainText("hello from e2e")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")

  await page.reload()
  await expect(page.getByLabel("用户消息")).toContainText("hello from e2e")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")
})

test("keeps two conversations isolated while switching between them", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "hello first conversation")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")

  await createConversation(page)
  await send(page, "second conversation")
  await expect(page.getByLabel("Assistant 消息")).toContainText("ok")

  const conversationButtons = page
    .getByRole("navigation", { name: "会话列表" })
    .getByRole("button")
  await conversationButtons.nth(1).click()
  await expect(page.getByLabel("用户消息")).toContainText("hello first conversation")
  await expect(page.getByLabel("用户消息")).not.toContainText("second conversation")

  await conversationButtons.nth(0).click()
  await expect(page.getByLabel("用户消息")).toContainText("second conversation")
})

test("renders command tools and handles both approval decisions", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)

  await send(page, "[tool] [approval] accept this")
  await expect(page.getByLabel("工具状态")).toContainText("运行中")
  await expect(page.getByLabel("工具状态")).toContainText("完成")
  await page.getByRole("button", { name: "批准" }).click()
  await expect(page.getByLabel("Assistant 消息")).toContainText("approval accepted")

  await send(page, "[approval] decline this")
  await expect(page.getByRole("group", { name: "Codex 请求运行命令" })).toBeVisible()
  await page.getByRole("button", { name: "拒绝" }).click()
  await expect(page.getByLabel("Assistant 消息").last()).toContainText("approval declined")
})

test("shows one sanitized generic tool identity from running through completed", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)

  await send(page, "[generic-tool]")
  await expect(page.getByLabel("工具状态")).toContainText("使用工具：运行中")
  await page.getByRole("button", { name: "批准" }).click()
  await expect(page.getByLabel("工具状态")).toContainText("使用工具：完成")
  await expect(page.getByRole("button", { name: "批准" })).toBeEnabled()
  await page.getByRole("button", { name: "批准" }).click()
  await expect(page.getByLabel("Assistant 消息")).toContainText(
    "generic tool complete"
  )
  await expect(page.getByText(/private|mcpToolCall|secret/i)).toHaveCount(0)
})

test("rejects a second turn with 409 and cancels the active turn", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "[wait] keep active")
  await expect(page.getByRole("button", { name: "取消" })).toBeVisible()

  const list = await page.request.get(`${taskmux.address}/api/conversations`)
  const [{ id }] = (await list.json()) as [{ id: string }]
  const conflict = await page.request.post(
    `${taskmux.address}/api/conversations/${encodeURIComponent(id)}/messages`,
    { data: { text: "must conflict", clientRequestId: "e2e-conflict" } }
  )
  expect(conflict.status()).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: "turn_conflict" } })

  await page.getByRole("button", { name: "取消" }).click()
  await expect(page.getByText("已中断", { exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: "消息" }).fill("send is unlocked")
  await expect(page.getByRole("button", { name: "发送" })).toBeEnabled()
})

test("restarts the fake App Server once and continues serving the same page", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "[crash] first exit")

  await expect.poll(() => taskmux.clientStarts).toBe(2)
  await expect.poll(() => taskmux.readyClientStarts).toBe(2)
  await expect(page.getByRole("button", { name: "发送" })).toBeEnabled()
  await send(page, "hello after restart")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")
})

test("degrades after a second consecutive crash and shows a stable manual action", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "[crash] first exit")
  await expect.poll(() => taskmux.clientStarts).toBe(2)
  await expect.poll(() => taskmux.readyClientStarts).toBe(2)
  await expect(page.getByRole("button", { name: "发送" })).toBeEnabled()

  await send(page, "[crash] second exit")
  await expect
    .poll(async () => (await page.request.get(`${taskmux.address}/api/health`)).status())
    .toBe(503)
  expect(taskmux.clientStarts).toBe(2)

  await page.reload()
  await expect(page.getByRole("alert", { name: "Codex 诊断" })).toContainText(
    "重启 TaskMux"
  )
  await expect(page.getByRole("alert", { name: "Codex 诊断" })).not.toContainText(
    "fake app-server"
  )
})

test("resumes the native session after restarting the service with the same database", async ({
  page,
  taskmux,
}) => {
  await page.goto(taskmux.address)
  await createConversation(page)
  await send(page, "hello before service restart")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")

  await taskmux.restartService()
  await page.goto(taskmux.address)
  await expect(page.getByLabel("用户消息")).toContainText("hello before service restart")
  await expect(page.getByLabel("Assistant 消息")).toContainText("hello world")

  await send(page, "continue after service restart")
  await expect(page.getByLabel("用户消息").last()).toContainText(
    "continue after service restart"
  )
  await expect(page.getByLabel("Assistant 消息").last()).toContainText("ok")

  await page.reload()
  await expect(page.getByLabel("用户消息")).toHaveCount(2)
  await expect(page.getByLabel("用户消息").first()).toContainText(
    "hello before service restart"
  )
  await expect(page.getByLabel("用户消息").last()).toContainText(
    "continue after service restart"
  )
  await expect(page.getByLabel("Assistant 消息").first()).toContainText("hello world")
  await expect(page.getByLabel("Assistant 消息").last()).toContainText("ok")
})
