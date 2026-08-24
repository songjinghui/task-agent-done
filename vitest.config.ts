import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
})
