import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { resolveDataDir } from "./data-dir.js"

export type ServerConfig = {
  workspace: string
  host: "127.0.0.1"
  port: number
  dataDir: string
  dev: boolean
}

export function parseServerConfig(
  argv: string[],
  env: NodeJS.ProcessEnv
): ServerConfig {
  const workspaceArgument = readArgument(argv, "--workspace")

  if (workspaceArgument === undefined) {
    throw new Error("--workspace is required")
  }

  if (!isAbsolute(workspaceArgument)) {
    throw new Error("Workspace must be an absolute path")
  }

  const workspace = realpathSync(workspaceArgument)

  if (!statSync(workspace).isDirectory()) {
    throw new Error("Workspace must be a directory")
  }

  const portArgument = readArgument(argv, "--port")
  const port =
    portArgument === undefined && !argv.includes("--port")
      ? 4317
      : Number(portArgument)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535")
  }

  return {
    workspace,
    host: "127.0.0.1",
    port,
    dataDir:
      env.TASKMUX_DATA_DIR ?? resolveDataDir(env, process.platform, homedir()),
    dev: env.NODE_ENV !== "production",
  }
}

function readArgument(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}
