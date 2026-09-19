import { describe, expect, it } from "vitest";

import { getBuildVersion, getDeploymentConfig, isLiveEvaluationEnabled } from "@/config/deployment";

describe("deployment configuration", () => {
  it("keeps live evaluations available by default outside production", () => {
    expect(isLiveEvaluationEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isLiveEvaluationEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("disables live evaluations unconditionally in production", () => {
    expect(isLiveEvaluationEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      isLiveEvaluationEnabled({
        NODE_ENV: "production",
        ENABLE_LIVE_EVALUATIONS: "true",
      }),
    ).toBe(false);
  });

  it("validates health-safe versions and bounded readiness timeouts", () => {
    expect(
      getDeploymentConfig({
        APP_VERSION: "0123456789abcdef",
        DATABASE_READINESS_TIMEOUT_MS: "500",
        NODE_ENV: "production",
      }),
    ).toMatchObject({
      appVersion: "0123456789abcdef",
      databaseReadinessTimeoutMs: 500,
    });
    expect(() =>
      getDeploymentConfig({ APP_VERSION: "unsafe value", NODE_ENV: "development" }),
    ).toThrow("Deployment configuration is invalid.");
    expect(() =>
      getDeploymentConfig({ ENABLE_LIVE_EVALUATIONS: "yes", NODE_ENV: "development" }),
    ).toThrow("Deployment configuration is invalid.");
  });

  it("reads liveness version without depending on unrelated deployment values", () => {
    expect(
      getBuildVersion({
        APP_VERSION: "0123456789abcdef",
        ENABLE_LIVE_EVALUATIONS: "invalid",
        NODE_ENV: "production",
      }),
    ).toBe("0123456789abcdef");
  });
});
