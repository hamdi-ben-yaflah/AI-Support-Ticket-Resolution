import { describe, expect, it } from "vitest";

import { getObservabilityConfig } from "@/config/observability";

describe("observability configuration", () => {
  it("keeps tracing disabled when configuration is absent", () => {
    expect(getObservabilityConfig({ NODE_ENV: "test" })).toEqual({ enabled: false });
  });

  it("rejects partial credentials even when exporting is disabled", () => {
    expect(() =>
      getObservabilityConfig({ NODE_ENV: "test", LANGFUSE_PUBLIC_KEY: "pk-test" }),
    ).toThrowError("Observability configuration is invalid.");
  });

  it("requires credentials when exporting is enabled", () => {
    expect(() =>
      getObservabilityConfig({ NODE_ENV: "test", LANGFUSE_ENABLED: "true" }),
    ).toThrowError("Observability configuration is invalid.");
  });

  it("returns only validated exporter settings", () => {
    expect(
      getObservabilityConfig({
        NODE_ENV: "test",
        LANGFUSE_ENABLED: "true",
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
        LANGFUSE_ENVIRONMENT: "test",
        LANGFUSE_RELEASE: "revision-1",
      }),
    ).toEqual({
      enabled: true,
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://cloud.langfuse.com",
      environment: "test",
      release: "revision-1",
    });
  });
});
