import { join } from "node:path"

export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string
): string {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "TaskMux")
  }

  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"), "TaskMux")
  }

  return join(env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"), "taskmux")
}
