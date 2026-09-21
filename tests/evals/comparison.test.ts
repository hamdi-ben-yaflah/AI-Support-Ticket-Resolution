import { beforeAll, describe, expect, it } from "vitest";

import {
  PersistedEvaluationRunSchema,
  type PersistedEvaluationRun,
} from "@/evals/comparison-contracts";
import { compareEvaluationRuns, EvaluationComparisonError } from "@/evals/comparison";
import type { EvaluationReport } from "@/evals/contracts";
import { reportToPersistedRun } from "@/evals/persistence";
import { makeEvaluationReport } from "../support/evaluation";

let report: EvaluationReport;

beforeAll(async () => {
  report = await makeEvaluationReport();
});

function pair(): [PersistedEvaluationRun, PersistedEvaluationRun] {
  const baseline = structuredClone(reportToPersistedRun(report));
  const candidate = structuredClone(baseline);
  candidate.runId = "323e4567-e89b-42d3-a456-426614174000";
  candidate.runtime.model = "candidate-model";
  candidate.judgeModel = "candidate-model";
  candidate.runtime.promptVersions.resolution = "resolve.v5";
  candidate.runtime.retrieval.minimumSimilarity = 0.7;
  candidate.metrics.quality.categoryAccuracy = {
    value: 29 / 30,
    numerator: 29,
    denominator: 30,
    lowerBound: 0.833,
    upperBound: 0.991,
  };
  candidate.metrics.operations.latencyP50Ms += 10;
  candidate.metrics.operations.cachedInputTokens += 1_200;
  candidate.metrics.operations.cacheWriteInputTokens += 40;

  const firstBaseline = baseline.cases[0]!;
  firstBaseline.passed = false;
  firstBaseline.scores.categoryCorrect = false;
  const secondCandidate = candidate.cases[1]!;
  secondCandidate.passed = false;
  secondCandidate.scores.actionCorrect = false;
  const thirdCandidate = candidate.cases[2]!;
  if (!thirdCandidate.actual) throw new Error("Expected a valid actual result.");
  thirdCandidate.actual.confidence = 0.8;
  candidate.cases.reverse();
  return [
    PersistedEvaluationRunSchema.parse(baseline),
    PersistedEvaluationRunSchema.parse(candidate),
  ];
}

describe("evaluation persistence mapping", () => {
  it("keeps only allowlisted safe run and case fields", () => {
    const stored = reportToPersistedRun(report);
    const serialized = JSON.stringify(stored);
    expect(stored.cases).toHaveLength(report.cases.length);
    expect(serialized).not.toContain("ticket");
    expect(serialized).not.toContain("expected");
    expect(serialized).not.toContain("suggestedResponse");
    expect(serialized).not.toContain("judgeDecisions");
    expect(serialized).not.toContain("rationale");
    expect(serialized).not.toContain("content");
  });
});

describe("evaluation comparison", () => {
  it("uses candidate-minus-baseline deltas and deterministic case outcomes", () => {
    const [baseline, candidate] = pair();
    const comparison = compareEvaluationRuns(baseline, candidate);

    expect(comparison.quality.categoryAccuracy.delta).toBeCloseTo(-1 / 30);
    expect(comparison.operations.latencyP50Ms.delta).toBe(10);
    expect(comparison.operations.cachedInputTokens.delta).toBe(1_200);
    expect(comparison.operations.cacheWriteInputTokens.delta).toBe(40);
    expect(comparison.operations.estimatedCostUsd.delta).toBeNull();
    expect(comparison.versionDifferences.map((item) => item.field)).toEqual([
      "model",
      "judgeModel",
      "prompt.resolution",
    ]);
    expect(comparison.configurationDifferences.map((item) => item.field)).toContain("retrieval");
    expect(comparison.cases.map((item) => item.caseId)).toEqual(
      [...comparison.cases.map((item) => item.caseId)].sort(),
    );
    expect(comparison.cases[0]?.outcome).toBe("improved");
    expect(comparison.cases[1]?.outcome).toBe("regressed");
    expect(comparison.cases[2]?.outcome).toBe("changed");
    expect(comparison.caseSummary).toMatchObject({ improved: 1, regressed: 1, changed: 1 });
  });

  it("rejects the same run and incompatible dataset or case sets", () => {
    const [baseline, candidate] = pair();
    expect(() => compareEvaluationRuns(baseline, baseline)).toThrowError(EvaluationComparisonError);

    const otherDataset = structuredClone(candidate);
    otherDataset.dataset.sha256 = "b".repeat(64);
    expect(() => compareEvaluationRuns(baseline, otherDataset)).toThrowError(
      expect.objectContaining({ code: "incompatible_dataset" }),
    );

    const otherCases = structuredClone(candidate);
    otherCases.cases.pop();
    expect(() => compareEvaluationRuns(baseline, otherCases)).toThrowError(
      expect.objectContaining({ code: "incompatible_cases" }),
    );
  });
});

describe("persisted evaluation history compatibility", () => {
  it("parses a run stored before cache telemetry existed", () => {
    const stored = structuredClone(reportToPersistedRun(report)) as Record<string, unknown>;
    const metrics = stored.metrics as { operations: Record<string, unknown> };
    delete metrics.operations.cachedInputTokens;
    delete metrics.operations.cacheWriteInputTokens;
    for (const item of stored.cases as { telemetry: Record<string, unknown> }[]) {
      delete item.telemetry.generationCachedInputTokens;
      delete item.telemetry.generationCacheWriteTokens;
      delete item.telemetry.judgeCachedInputTokens;
      delete item.telemetry.judgeCacheWriteTokens;
    }

    const parsed = PersistedEvaluationRunSchema.parse(stored);
    expect(parsed.metrics.operations.cachedInputTokens).toBe(0);
    expect(parsed.cases[0]?.telemetry.generationCachedInputTokens).toBe(0);
  });
});
