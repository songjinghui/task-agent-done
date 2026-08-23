import { describe, expect, it } from "vitest"
import { isApprovalDecision } from "./contracts.js"

describe("isApprovalDecision", () => {
  it("accepts only the two approval decisions", () => {
    expect(isApprovalDecision("accept")).toBe(true)
    expect(isApprovalDecision("decline")).toBe(true)
    expect(isApprovalDecision("approve")).toBe(false)
    expect(isApprovalDecision("reject")).toBe(false)
    expect(isApprovalDecision("")).toBe(false)
  })
})
