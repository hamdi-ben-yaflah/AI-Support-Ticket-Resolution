import "server-only";

import { randomUUID } from "node:crypto";

import { isLlmError } from "@/ai/errors";
import type { GenerateResult } from "@/ai/types";
import type { EvaluationPricing } from "@/config/evaluation";
import { ResolutionExecutionSchema, type ResolutionExecution } from "@/domain/resolution-run";
import {
  CitationJudgeOutputSchema,
  EvaluationCaseResultSchema,
  EvaluationReportSchema,
  type CitationJudgeOutput,
  type EvaluationCaseResult,
  type EvaluationReport,
  type GoldenCase,
} from "@/evals/contracts";
import type { GoldenDataset } from "@/evals/dataset";
import {
  aggregateQualityMetrics,
  failedExecutionScores,
  gradeExecution,
  nearestRankPercentile,
} from "@/evals/graders";
import { CITATION_JUDGE_PROMPT_VERSION } from "@/evals/prompts/citation-judge.v1";
import { isCassetteMissError } from "@/evals/replay";
import { EVALUATION_THRESHOLD_VERSION, evaluateThresholds } from "@/evals/thresholds";
import { isRetrievalError } from "@/retrieval/errors";
import type { RetrievedEvidence } from "@/retrieval/types";

export type EvaluationRuntime = {
  provider: string;
  models?: {
    classification: string;
    resolution: string;
    judge: string;
  };
  model?: string;
  promptVersions: {
    classification: string;
    resolution: string;
  };
  retrieval: {
    version: string;
    candidateCount: number;
    finalCount: number;
    minimumSimilarity: number;
    maximumContextTokens: number;
    minimumEvidenceCount: number;
  };
  resolutionPolicy: {
    version: string;
    minimumConfidence: number;
  };
  pricing: EvaluationPricing;
};

export type EvaluationDependencies = {
  execute: (
    goldenCase: GoldenCase,
    context: {
      traceId: string;
      recordRetrieved: (evidence: readonly RetrievedEvidence[]) => void;
    },
  ) => Promise<ResolutionExecution>;
  judge: (
    execution: ResolutionExecution,
    traceId: string,
    goldenCase: GoldenCase,
  ) => Promise<GenerateResult<CitationJudgeOutput> | null>;
};

type RunEvaluationInput = {
  dataset: GoldenDataset;
  concurrency: number;
  runtime: EvaluationRuntime;
  dependencies: EvaluationDependencies;
  createId?: () => string;
  now?: () => Date;
};

function safeCaseError(error: unknown, stage: "resolution" | "judge") {
  if (isRetrievalError(error)) {
    return {
      stage,
      code: "retrieval_unavailable" as const,
      message: "Knowledge retrieval was unavailable for this case.",
    };
  }
  if (isLlmError(error)) {
    const messages = {
      configuration: "The model configuration was invalid for this case.",
      timeout: "The model request timed out for this case.",
      unavailable: "The model provider was unavailable for this case.",
      refused: "The model refused this case.",
      truncated: "The model output was truncated for this case.",
      invalid_output: "The model output failed validation for this case.",
      unexpected: "The model request failed unexpectedly for this case.",
    } as const;
    return { stage, code: error.code, message: messages[error.code] };
  }
  return {
    stage,
    code: "unexpected" as const,
    message: "The evaluation case failed unexpectedly.",
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function casePassed(result: Omit<EvaluationCaseResult, "passed">): boolean {
  const scores = result.scores;
  return (
    result.error === null &&
    scores.schemaValid &&
    scores.categoryCorrect &&
    scores.priorityCorrect &&
    scores.actionCorrect &&
    scores.abstentionCorrect &&
    (scores.retrievalRecallAt5 === null || scores.retrievalRecallAt5 === 1) &&
    (scores.citationExistence === null || scores.citationExistence === 1) &&
    (scores.citationSupport === null || scores.citationSupport === 1)
  );
}

async function runCase(
  goldenCase: GoldenCase,
  dependencies: EvaluationDependencies,
  createId: () => string,
  now: () => Date,
): Promise<EvaluationCaseResult> {
  const startedAt = now().getTime();
  const traceId = createId();
  let retrieved: readonly RetrievedEvidence[] = [];
  let execution: ResolutionExecution;

  try {
    execution = ResolutionExecutionSchema.parse(
      await dependencies.execute(goldenCase, {
        traceId,
        recordRetrieved: (evidence) => {
          retrieved = evidence;
        },
      }),
    );
  } catch (error) {
    if (isCassetteMissError(error)) throw error;
    const partial = {
      caseId: goldenCase.id,
      tags: goldenCase.tags,
      expected: goldenCase.expected,
      actual: null,
      scores: failedExecutionScores(goldenCase),
      judgeDecisions: [],
      telemetry: {
        latencyMs: Math.max(0, now().getTime() - startedAt),
        generationInputTokens: 0,
        generationOutputTokens: 0,
        classificationInputTokens: 0,
        classificationOutputTokens: 0,
        classificationCachedInputTokens: 0,
        classificationCacheWriteTokens: 0,
        resolutionInputTokens: 0,
        resolutionOutputTokens: 0,
        resolutionCachedInputTokens: 0,
        resolutionCacheWriteTokens: 0,
        generationCachedInputTokens: 0,
        generationCacheWriteTokens: 0,
        judgeInputTokens: 0,
        judgeOutputTokens: 0,
        judgeCachedInputTokens: 0,
        judgeCacheWriteTokens: 0,
        retryCount: isLlmError(error) ? error.retryCount : 0,
      },
      error: safeCaseError(error, "resolution"),
    };
    return EvaluationCaseResultSchema.parse({ ...partial, passed: casePassed(partial) });
  }

  let judge: GenerateResult<CitationJudgeOutput> | null = null;
  let judgeError: ReturnType<typeof safeCaseError> | null = null;
  try {
    judge = await dependencies.judge(execution, traceId, goldenCase);
    if (judge) CitationJudgeOutputSchema.parse(judge.value);
  } catch (error) {
    if (isCassetteMissError(error)) throw error;
    judgeError = safeCaseError(error, "judge");
  }

  const decisions = judge?.value.decisions ?? [];
  const scores = gradeExecution({ goldenCase, execution, retrieved, judgeDecisions: decisions });
  const executionModels = execution.metadata.models ?? {
    classification: execution.metadata.model ?? "legacy",
    resolution: execution.metadata.model ?? "legacy",
  };
  const citedChunkIds = execution.citedSources.map((source) => source.chunkId);
  const citedSourceIds = unique(execution.citedSources.map((source) => source.sourceId));
  const partial = {
    caseId: goldenCase.id,
    tags: goldenCase.tags,
    expected: goldenCase.expected,
    actual: {
      category: execution.proposal.category,
      priority: execution.proposal.priority,
      confidence: execution.proposal.confidence,
      action: execution.proposal.action,
      citedChunkIds,
      citedSourceIds,
      retrievedChunkIds: retrieved.map((item) => item.chunkId),
      retrievedSourceIds: unique(retrieved.map((item) => item.sourceId)),
      provider: execution.metadata.provider,
      models: {
        classification: executionModels.classification,
        resolution: executionModels.resolution,
      },
      promptVersions: execution.metadata.promptVersions,
    },
    scores,
    judgeDecisions: decisions,
    telemetry: {
      latencyMs: Math.max(execution.metadata.latencyMs, now().getTime() - startedAt),
      generationInputTokens: execution.metadata.inputTokens,
      generationOutputTokens: execution.metadata.outputTokens,
      classificationInputTokens:
        execution.metadata.taskUsage?.classification.inputTokens ?? execution.metadata.inputTokens,
      classificationOutputTokens:
        execution.metadata.taskUsage?.classification.outputTokens ??
        execution.metadata.outputTokens,
      classificationCachedInputTokens:
        execution.metadata.taskUsage?.classification.cachedInputTokens ??
        execution.metadata.cachedInputTokens,
      classificationCacheWriteTokens:
        execution.metadata.taskUsage?.classification.cacheWriteInputTokens ??
        execution.metadata.cacheWriteInputTokens,
      resolutionInputTokens: execution.metadata.taskUsage?.resolution.inputTokens ?? 0,
      resolutionOutputTokens: execution.metadata.taskUsage?.resolution.outputTokens ?? 0,
      resolutionCachedInputTokens: execution.metadata.taskUsage?.resolution.cachedInputTokens ?? 0,
      resolutionCacheWriteTokens:
        execution.metadata.taskUsage?.resolution.cacheWriteInputTokens ?? 0,
      generationCachedInputTokens: execution.metadata.cachedInputTokens,
      generationCacheWriteTokens: execution.metadata.cacheWriteInputTokens,
      judgeInputTokens: judge?.usage.inputTokens ?? 0,
      judgeOutputTokens: judge?.usage.outputTokens ?? 0,
      judgeCachedInputTokens: judge?.usage.cachedInputTokens ?? 0,
      judgeCacheWriteTokens: judge?.usage.cacheWriteInputTokens ?? 0,
      retryCount: execution.metadata.retryCount + (judge?.retryCount ?? 0),
    },
    error: judgeError,
  };
  return EvaluationCaseResultSchema.parse({ ...partial, passed: casePassed(partial) });
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await task(value);
    }
  });
  await Promise.all(workers);
  return output;
}

function estimateCost(
  results: readonly EvaluationCaseResult[],
  pricing: EvaluationPricing,
): number | null {
  if (!pricing) return null;
  const inputTokens = results.reduce(
    (sum, item) => sum + item.telemetry.generationInputTokens + item.telemetry.judgeInputTokens,
    0,
  );
  const outputTokens = results.reduce(
    (sum, item) => sum + item.telemetry.generationOutputTokens + item.telemetry.judgeOutputTokens,
    0,
  );
  const cacheReadTokens = results.reduce(
    (sum, item) =>
      sum + item.telemetry.generationCachedInputTokens + item.telemetry.judgeCachedInputTokens,
    0,
  );
  const cacheWriteTokens = results.reduce(
    (sum, item) =>
      sum + item.telemetry.generationCacheWriteTokens + item.telemetry.judgeCacheWriteTokens,
    0,
  );
  return (
    (inputTokens * pricing.inputUsdPerMillion +
      outputTokens * pricing.outputUsdPerMillion +
      cacheReadTokens * pricing.cacheReadUsdPerMillion +
      cacheWriteTokens * pricing.cacheWriteUsdPerMillion) /
    1_000_000
  );
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationReport> {
  const startedAt = (input.now ?? (() => new Date()))();
  const createId = input.createId ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const results = await mapBounded(input.dataset.cases, input.concurrency, (item) =>
    runCase(item, input.dependencies, createId, now),
  );
  const quality = aggregateQualityMetrics(results);
  const thresholds = evaluateThresholds(quality);
  const status = thresholds.every((threshold) => threshold.passed) ? "pass" : "regression";
  const sum = (field: keyof EvaluationCaseResult["telemetry"]) =>
    results.reduce((total, result) => total + (result.telemetry[field] ?? 0), 0);

  return EvaluationReportSchema.parse({
    schemaVersion: "evaluation-report.v1",
    runId: createId(),
    status,
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    dataset: {
      version: input.dataset.version,
      sha256: input.dataset.sha256,
      caseCount: input.dataset.cases.length,
    },
    runtime: {
      provider: input.runtime.provider,
      models: input.runtime.models ?? {
        classification: input.runtime.model!,
        resolution: input.runtime.model!,
        judge: input.runtime.model!,
      },
      promptVersions: {
        ...input.runtime.promptVersions,
        citationJudge: CITATION_JUDGE_PROMPT_VERSION,
      },
      retrieval: input.runtime.retrieval,
      resolutionPolicy: input.runtime.resolutionPolicy,
      concurrency: input.concurrency,
      pricing: input.runtime.pricing,
    },
    metrics: {
      quality,
      operations: {
        latencyP50Ms: nearestRankPercentile(
          results.map((result) => result.telemetry.latencyMs),
          0.5,
        ),
        latencyP95Ms: nearestRankPercentile(
          results.map((result) => result.telemetry.latencyMs),
          0.95,
        ),
        generationInputTokens: sum("generationInputTokens"),
        generationOutputTokens: sum("generationOutputTokens"),
        judgeInputTokens: sum("judgeInputTokens"),
        judgeOutputTokens: sum("judgeOutputTokens"),
        cachedInputTokens: sum("generationCachedInputTokens") + sum("judgeCachedInputTokens"),
        cacheWriteInputTokens: sum("generationCacheWriteTokens") + sum("judgeCacheWriteTokens"),
        averageGenerationInputTokens: sum("generationInputTokens") / results.length,
        averageGenerationOutputTokens: sum("generationOutputTokens") / results.length,
        averageJudgeInputTokens: sum("judgeInputTokens") / results.length,
        averageJudgeOutputTokens: sum("judgeOutputTokens") / results.length,
        retryCount: sum("retryCount"),
        errorCount: results.filter((result) => result.error !== null).length,
        estimatedCostUsd: estimateCost(results, input.runtime.pricing),
      },
    },
    thresholdVersion: EVALUATION_THRESHOLD_VERSION,
    thresholds,
    cases: results,
  });
}
