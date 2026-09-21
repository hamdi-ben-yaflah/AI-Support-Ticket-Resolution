import { describe, expect, it } from "vitest";

import { EvaluationReportSchema, type EvaluationReport } from "@/evals/contracts";
import { formatEvaluationSummary } from "@/evals/format";

import { makeEvaluationReport } from "../support/evaluation";

async function withOperations(overrides: Partial<EvaluationReport["metrics"]["operations"]>) {
  const report = await makeEvaluationReport();
  return EvaluationReportSchema.parse({
    ...report,
    metrics: {
      ...report.metrics,
      operations: { ...report.metrics.operations, ...overrides },
    },
  });
}

describe("evaluation summary formatting", () => {
  it("prints the cache hit rate over uncached, read, and written tokens", async () => {
    const summary = formatEvaluationSummary(
      await withOperations({
        generationInputTokens: 100,
        judgeInputTokens: 0,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 100,
      }),
    );

    expect(summary).toContain("cache hit 80.0%");
  });

  it("prints n/a when no input tokens were billed at all", async () => {
    const summary = formatEvaluationSummary(
      await withOperations({
        generationInputTokens: 0,
        judgeInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      }),
    );

    expect(summary).toContain("cache hit n/a");
  });
});
