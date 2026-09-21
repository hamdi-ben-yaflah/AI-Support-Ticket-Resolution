import { describe, expect, it } from "vitest";

import { getEvaluationPricing } from "@/config/evaluation";

const fullPricing = {
  NODE_ENV: "test" as const,
  EVAL_ANTHROPIC_INPUT_USD_PER_MILLION: "5",
  EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION: "25",
  EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION: "0.5",
  EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION: "6.25",
};

describe("evaluation pricing configuration", () => {
  it("returns null when no prices are configured", () => {
    expect(getEvaluationPricing({ NODE_ENV: "test" })).toBeNull();
  });

  it("reads all four prices together", () => {
    expect(getEvaluationPricing(fullPricing)).toEqual({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
    });
  });

  it("rejects a partially configured price set", () => {
    const partial = { ...fullPricing, EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION: "" };
    expect(() => getEvaluationPricing(partial)).toThrow(
      "Evaluation pricing configuration is invalid.",
    );
  });
});
