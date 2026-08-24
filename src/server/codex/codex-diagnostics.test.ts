import { describe, expect, it, vi } from "vitest"
import {
  diagnoseCodex,
  type CodexCommandRunner,
} from "./codex-diagnostics.js"

describe("diagnoseCodex", () => {
  it("runs version and app-server help with argv arrays and five-second timeouts", async () => {
    const run = vi.fn<CodexCommandRunner>().mockResolvedValue({ stdout: "ok" })

    await expect(diagnoseCodex("codex", { run })).resolves.toEqual({
      status: "ok",
    })

    expect(run.mock.calls).toEqual([
      ["codex", ["--version"], 5_000],
      ["codex", ["app-server", "--help"], 5_000],
    ])
  })

  it("classifies a missing executable without exposing the spawn error", async () => {
    const missing = Object.assign(new Error("spawn /secret/bin/codex ENOENT"), {
      code: "ENOENT",
      env: { SECRET_TOKEN: "do-not-leak" },
    })
    const run = vi.fn<CodexCommandRunner>().mockRejectedValue(missing)

    const result = await diagnoseCodex("codex", { run })

    expect(result).toEqual({
      status: "error",
      error: {
        code: "codex_not_found",
        message: "Codex CLI is not installed or is not available on PATH.",
      },
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("classifies unsupported app-server help without exposing stderr", async () => {
    const run = vi
      .fn<CodexCommandRunner>()
      .mockResolvedValueOnce({ stdout: "codex 1.0" })
      .mockRejectedValueOnce(
        Object.assign(new Error("command failed"), {
          stderr: "unknown command with /private/path and token",
        })
      )

    const result = await diagnoseCodex("codex", { run })

    expect(result).toEqual({
      status: "error",
      error: {
        code: "codex_version_unsupported",
        message: "This Codex CLI version does not support app-server.",
      },
    })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(JSON.stringify(result)).not.toContain("token")
  })
})
