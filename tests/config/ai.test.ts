import { describe, expect, it } from "vitest";

import { getAiConfig } from "@/config/ai";

const baseEnvironment = {
  NODE_ENV: "test" as const,
  ANTHROPIC_API_KEY: "test-key",
  LLM_MODEL: "claude-opus-5",
};

describe("AI configuration", () => {
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
