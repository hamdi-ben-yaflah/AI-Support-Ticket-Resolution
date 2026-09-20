import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3104";
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/security-production.spec.ts", "**/p0-journeys.spec.ts"],
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/security",
  use: { ...devices["Desktop Chrome"], baseURL },
  webServer: {
    command: "pnpm start --hostname 127.0.0.1 --port 3104",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: "production",
      APP_ORIGIN: baseURL,
      ENABLE_LIVE_EVALUATIONS: "true",
      // These tests must not use live provider credentials or export traces.
      ANTHROPIC_API_KEY: "",
      VOYAGE_API_KEY: "",
      LANGFUSE_ENABLED: "false",
    },
  },
});
