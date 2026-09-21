import { describe, expect, it } from "vitest";

import { getAiConfig } from "@/config/ai";

const baseEnvironment = {
  NODE_ENV: "test" as const,
  ANTHROPIC_API_KEY: "test-key",
  LLM_MODEL: "claude-opus-5",
};

describe("AI configuration", () => {
  it("falls back to LLM_MODEL for every task", () => {
    expect(getAiConfig(baseEnvironment).models).toEqual({
      classification: "claude-opus-5",
      resolution: "claude-opus-5",
      judge: "claude-opus-5",
    });
  });

  it("resolves independent per-task overrides", () => {
    expect(
      getAiConfig({
        ...baseEnvironment,
        LLM_MODEL_CLASSIFICATION: "claude-haiku-4-5-20251001",
        LLM_MODEL_RESOLUTION: "claude-opus-5",
        LLM_MODEL_JUDGE: "claude-sonnet-5",
      }).models,
    ).toEqual({
      classification: "claude-haiku-4-5-20251001",
      resolution: "claude-opus-5",
      judge: "claude-sonnet-5",
    });
  });

  it("rejects configurations without a resolvable model for every task", () => {
    expect(() =>
      getAiConfig({
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: "test-key",
        LLM_MODEL_CLASSIFICATION: "claude-haiku-4-5-20251001",
      }),
    ).toThrow("AI configuration is invalid or incomplete.");
  });

  it("enables prompt caching by default", () => {
    expect(getAiConfig(baseEnvironment).promptCacheEnabled).toBe(true);
  });

  it.each([
    ["false", false],
    ["true", true],
  ])("reads ANTHROPIC_PROMPT_CACHE_ENABLED=%s as %s", (value, expected) => {
    expect(
      getAiConfig({ ...baseEnvironment, ANTHROPIC_PROMPT_CACHE_ENABLED: value }).promptCacheEnabled,
    ).toBe(expected);
  });

  it("rejects a non-boolean prompt cache flag", () => {
    expect(() =>
      getAiConfig({ ...baseEnvironment, ANTHROPIC_PROMPT_CACHE_ENABLED: "yes" }),
    ).toThrow("AI configuration is invalid or incomplete.");
  });
});
