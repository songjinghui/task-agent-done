import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
})
