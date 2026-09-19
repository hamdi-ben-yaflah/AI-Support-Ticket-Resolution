import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "E2E_DATABASE_URL is required for database-backed browser tests; refusing to use DATABASE_URL.",
  );
}

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.endsWith("_test")) {
  throw new Error("E2E_DATABASE_URL must point to a PostgreSQL database ending in _test.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/database-assertions.spec.ts",
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/database",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3101" },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3101",
    url: "http://127.0.0.1:3101",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ENABLE_LIVE_EVALUATIONS: "false",
    },
  },
});
