import { defineConfig, devices } from "@playwright/test";

if (process.env.LIVE_PROVIDER_SMOKE !== "true") {
  throw new Error("Set LIVE_PROVIDER_SMOKE=true to run the cost-bearing live-provider smoke test.");
}

const budget = Number(process.env.LIVE_PROVIDER_SMOKE_BUDGET_USD);
if (!Number.isFinite(budget) || budget <= 0) {
  throw new Error("Set LIVE_PROVIDER_SMOKE_BUDGET_USD to a positive approved budget.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/live-provider-smoke.spec.ts",
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/live-provider-smoke",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3102" },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3102",
    url: "http://127.0.0.1:3102",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, ENABLE_LIVE_EVALUATIONS: "false" },
  },
});
