import type { EvaluationReport } from "@/evals/contracts";
import { compareEvaluationRuns } from "@/evals/comparison";
import type { EvaluationComparison, EvaluationRunSummary } from "@/evals/comparison-contracts";
import { reportToPersistedRun } from "@/evals/persistence";

const TRACE_ID = "923e4567-e89b-42d3-a456-426614174000";
const BASELINE_ID = "a23e4567-e89b-42d3-a456-426614174000";
const CANDIDATE_ID = "b23e4567-e89b-42d3-a456-426614174000";

export type EvaluationFixtures = {
  report: EvaluationReport;
  summaries: EvaluationRunSummary[];
  comparison: EvaluationComparison;
};

function metric(numerator: number, denominator = 30) {
  return { value: numerator / denominator, numerator, denominator };
}

function makeReport(runId: string): EvaluationReport {
  const chunkId = "223e4567-e89b-42d3-a456-426614174000";
  const cases = Array.from({ length: 30 }, (_, index) => {
    const failed = index === 0;
    return {
      caseId: `eval-case-${String(index + 1).padStart(2, "0")}`,
      tags: ["normal", "answerable"],
      expected: {
        category: "billing" as const,
        priorities: ["medium" as const],
        actions: ["reply" as const],
        relevantSourceIds: ["duplicate-charges"],
        shouldAbstain: false,
      },
      actual: {
        category: failed ? ("technical" as const) : ("billing" as const),
        priority: "medium" as const,
        confidence: 0.95,
        action: "reply" as const,
        citedChunkIds: [chunkId],
        citedSourceIds: ["duplicate-charges"],
        retrievedChunkIds: [chunkId],
        retrievedSourceIds: ["duplicate-charges"],
        provider: "fake",
        model: "fake-model",
        promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
      },
      scores: {
        schemaValid: true,
        categoryCorrect: !failed,
        priorityCorrect: true,
        actionCorrect: true,
        abstentionCorrect: true,
        retrievalRecallAt5: 1,
        citationExistence: 1,
        citationSupport: 1,
      },
      judgeDecisions: [
        {
          citationId: chunkId,
          supported: true,
          rationale: "The evidence directly supports the claim.",
        },
      ],
      telemetry: {
        latencyMs: 50,
        generationInputTokens: 20,
        generationOutputTokens: 10,
        generationCachedInputTokens: 0,
        generationCacheWriteTokens: 0,
        judgeInputTokens: 5,
        judgeOutputTokens: 3,
        judgeCachedInputTokens: 0,
        judgeCacheWriteTokens: 0,
        retryCount: 0,
      },
      error: null,
      passed: !failed,
    };
  });

  const quality = {
    schemaValidity: metric(30),
    categoryAccuracy: metric(29),
    priorityAccuracy: metric(30),
    actionAccuracy: metric(30),
    retrievalRecallAt5: metric(30),
    citationExistence: metric(30),
    citationSupport: metric(30),
    abstentionAccuracy: metric(30),
    abstentionPrecision: metric(30),
    abstentionRecall: metric(30),
  };

  return {
    schemaVersion: "evaluation-report.v1",
    runId,
    status: "regression",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    dataset: { version: "golden.v2", sha256: "a".repeat(64), caseCount: 30 },
    runtime: {
      provider: "fake",
      model: "fake-model",
      promptVersions: {
        classification: "classify.v1",
        resolution: "resolve.v4",
        citationJudge: "citation-judge.v1",
      },
      retrieval: {
        version: "retrieval.v1",
        candidateCount: 8,
        finalCount: 5,
        minimumSimilarity: 0.65,
        maximumContextTokens: 3500,
        minimumEvidenceCount: 1,
      },
      resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
      concurrency: 3,
      pricing: null,
    },
    metrics: {
      quality,
      operations: {
        latencyP50Ms: 50,
        latencyP95Ms: 80,
        generationInputTokens: 600,
        generationOutputTokens: 300,
        judgeInputTokens: 150,
        judgeOutputTokens: 90,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        averageGenerationInputTokens: 20,
        averageGenerationOutputTokens: 10,
        averageJudgeInputTokens: 5,
        averageJudgeOutputTokens: 3,
        retryCount: 0,
        errorCount: 0,
        estimatedCostUsd: null,
      },
    },
    thresholdVersion: "evaluation-thresholds.v1",
    thresholds: [
      {
        metric: "schemaValidity",
        threshold: 0.95,
        actual: 1,
        passed: true,
      },
    ],
    cases,
  };
}

export async function createEvaluationFixtures(): Promise<EvaluationFixtures> {
  const report = makeReport(CANDIDATE_ID);

  const candidate = reportToPersistedRun(report);
  const baseline = structuredClone(candidate);
  baseline.runId = BASELINE_ID;
  baseline.completedAt = "2026-01-01T00:00:00.000Z";
  baseline.runtime.model = "baseline-model";
  baseline.judgeModel = "baseline-model";
  baseline.runtime.promptVersions.resolution = "resolve.v3";
  baseline.runtime.retrieval.minimumSimilarity = 0.6;
  baseline.metrics.operations.latencyP50Ms = 40;
  baseline.cases[0] = {
    ...baseline.cases[0]!,
    passed: true,
    scores: { ...baseline.cases[0]!.scores, categoryCorrect: true },
  };

  const { cases: _baselineCases, ...baselineSummary } = baseline;
  const { cases: _candidateCases, ...candidateSummary } = candidate;
  void _baselineCases;
  void _candidateCases;

  return {
    report,
    summaries: [candidateSummary, baselineSummary],
    comparison: compareEvaluationRuns(baseline, candidate),
  };
}

export function apiResult<T>(data: T) {
  return { ok: true, traceId: TRACE_ID, data };
}
