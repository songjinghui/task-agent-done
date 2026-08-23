import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parseServerConfig } from "./config.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "taskmux-config-"))
const fixtureFile = join(fixtureDir, "not-a-directory")
writeFileSync(fixtureFile, "fixture")

afterAll(() => {
  rmSync(fixtureDir, { force: true, recursive: true })
})

describe("parseServerConfig", () => {
  it("normalizes one absolute workspace", () => {
    expect(parseServerConfig(["--workspace", fixtureDir], {})).toMatchObject({
      workspace: realpathSync(fixtureDir),
      host: "127.0.0.1",
    })
  })

  it("rejects a missing or relative workspace", () => {
    expect(() => parseServerConfig([], {})).toThrow("--workspace is required")
    expect(() => parseServerConfig(["--workspace", "relative"], {})).toThrow(
      "Workspace must be an absolute path"
    )
  })

  it("rejects a workspace that is not a directory", () => {
    expect(() => parseServerConfig(["--workspace", fixtureFile], {})).toThrow(
      "Workspace must be a directory"
    )
  })

  it("accepts only ports in the TCP range", () => {
    expect(() =>
      parseServerConfig(["--workspace", fixtureDir, "--port"], {})
    ).toThrow("Port must be an integer between 1 and 65535")
    expect(() =>
      parseServerConfig(["--workspace", fixtureDir, "--port", "0"], {})
    ).toThrow("Port must be an integer between 1 and 65535")
    expect(() =>
      parseServerConfig(["--workspace", fixtureDir, "--port", "65536"], {})
    ).toThrow("Port must be an integer between 1 and 65535")
    expect(
      parseServerConfig(["--workspace", fixtureDir, "--port", "65535"], {}).port
    ).toBe(65535)
  })

  it("uses port 4317 unless --port overrides it", () => {
    expect(parseServerConfig(["--workspace", fixtureDir], {}).port).toBe(4317)
    expect(
      parseServerConfig(["--workspace", fixtureDir, "--port", "4318"], {}).port
    ).toBe(4318)
  })

  it("runs in development except when NODE_ENV is production", () => {
    expect(parseServerConfig(["--workspace", fixtureDir], {}).dev).toBe(true)
    expect(
      parseServerConfig(["--workspace", fixtureDir], { NODE_ENV: "production" }).dev
    ).toBe(false)
  })

  it("uses TASKMUX_DATA_DIR only for its server-owned data directory", () => {
    expect(
      parseServerConfig(
        ["--workspace", fixtureDir],
        { TASKMUX_DATA_DIR: "/var/taskmux-data", XDG_DATA_HOME: "/var/ignored" }
      ).dataDir
    ).toBe("/var/taskmux-data")
  })
})
