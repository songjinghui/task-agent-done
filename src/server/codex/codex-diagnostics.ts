import { execFile } from "node:child_process"

export type CodexDiagnosticErrorCode =
  | "codex_not_found"
  | "codex_version_unsupported"
  | "codex_not_authenticated"

export type CodexDiagnostic =
  | { status: "ok" }
  | {
      status: "error"
      error: { code: CodexDiagnosticErrorCode; message: string }
    }

export type CodexCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string }>

const DIAGNOSTIC_TIMEOUT_MS = 5_000

export async function diagnoseCodex(
  command = "codex",
  dependencies: { run?: CodexCommandRunner } = {}
): Promise<CodexDiagnostic> {
  const run = dependencies.run ?? runCommand
  try {
    await run(command, ["--version"], DIAGNOSTIC_TIMEOUT_MS)
    await run(command, ["app-server", "--help"], DIAGNOSTIC_TIMEOUT_MS)
    return { status: "ok" }
  } catch (error) {
    if (isMissingExecutable(error)) {
      return diagnosticError(
        "codex_not_found",
        "Codex CLI is not installed or is not available on PATH."
      )
    }
    return diagnosticError(
      "codex_version_unsupported",
      "This Codex CLI version does not support app-server."
    )
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout })
      }
    )
  })
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

export function diagnosticError(
  code: CodexDiagnosticErrorCode,
  message: string
): CodexDiagnostic {
  return { status: "error", error: { code, message } }
}
