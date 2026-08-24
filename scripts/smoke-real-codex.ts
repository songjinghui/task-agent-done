import { realpathSync, statSync } from "node:fs"
import { CodexJsonRpcClient } from "../src/server/codex/json-rpc-client.js"
import { runRealCodexSmoke } from "./smoke-real-codex-support.js"

const workspaceInput = process.env.TASKMUX_SMOKE_WORKSPACE
if (!workspaceInput) {
  throw new Error("TASKMUX_SMOKE_WORKSPACE is required")
}
if (process.env.TASKMUX_SMOKE_DISPOSABLE !== "YES") {
  throw new Error(
    "Refusing to run: set TASKMUX_SMOKE_DISPOSABLE=YES only for an explicitly disposable workspace."
  )
}

const workspace = realpathSync(workspaceInput)
if (!statSync(workspace).isDirectory()) {
  throw new Error("TASKMUX_SMOKE_WORKSPACE must be an existing directory")
}

const client = new CodexJsonRpcClient({
  command: "codex",
  args: ["app-server"],
  cwd: workspace,
})

await runRealCodexSmoke(client, workspace)
process.stdout.write("TaskMux real Codex smoke passed.\n")
