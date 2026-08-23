import { describe, expect, it } from "vitest"
import { resolveDataDir } from "./data-dir.js"

describe("resolveDataDir", () => {
  it("uses the macOS application support directory", () => {
    expect(resolveDataDir({}, "darwin", "/Users/alex")).toBe(
      "/Users/alex/Library/Application Support/TaskMux"
    )
  })

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveDataDir({ LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local" }, "win32", "C:\\Users\\alex")
    ).toBe("C:\\Users\\alex\\AppData\\Local/TaskMux")
  })

  it("uses XDG_DATA_HOME on Linux when it is set", () => {
    expect(resolveDataDir({ XDG_DATA_HOME: "/srv/data" }, "linux", "/home/alex")).toBe(
      "/srv/data/taskmux"
    )
  })

  it("falls back to the Linux local-share directory", () => {
    expect(resolveDataDir({}, "linux", "/home/alex")).toBe(
      "/home/alex/.local/share/taskmux"
    )
  })
})
