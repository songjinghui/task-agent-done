import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ToolLine } from "./ToolLine.js"

afterEach(cleanup)

describe("ToolLine", () => {
  it.each([
    ["运行命令", "running", "运行命令：运行中"],
    ["修改文件", "completed", "修改文件：完成"],
    ["使用工具", "failed", "使用工具：失败"],
    ["unknown raw output /secret/path", "declined", "使用工具：已拒绝"],
  ] as const)("shows only the safe category and state", (label, status, visible) => {
    const view = render(
      <ToolLine tool={{ id: "tool-1", label, status }} />
    )

    expect(screen.getByRole("status")).toHaveAccessibleName(visible)
    expect(view.container).not.toHaveTextContent("/secret/path")
    expect(view.container).not.toHaveTextContent("raw output")
  })
})
