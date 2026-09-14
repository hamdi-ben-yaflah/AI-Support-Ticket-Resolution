import type {
  CitationJudgeDecision,
  EvaluationCaseResult,
  EvaluationCaseScoresSchema,
  EvaluationMetric,
  EvaluationQualityMetrics,
  GoldenCase,
} from "@/evals/contracts";
import type { ResolutionExecution } from "@/domain/resolution-run";
import type { RetrievedEvidence } from "@/retrieval/types";
import type { z } from "zod";

export type CaseScores = z.infer<typeof EvaluationCaseScoresSchema>;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function gradeExecution(input: {
  goldenCase: GoldenCase;
  execution: ResolutionExecution;
  retrieved: readonly RetrievedEvidence[];
  judgeDecisions: readonly CitationJudgeDecision[];
}): CaseScores {
  const { expected } = input.goldenCase;
  const { proposal } = input.execution;
  const retrievedAt5 = input.retrieved.slice(0, 5);
  const relevantRetrieved = new Set(
    retrievedAt5
      .map((item) => item.sourceId)
      .filter((sourceId) => expected.relevantSourceIds.includes(sourceId)),
  );
  const citations =
    proposal.action === "needs_human_review" ? [] : proposal.groundedReply.citations;
  const retrievedChunkIds = new Set(input.retrieved.map((item) => item.chunkId));
  const existingCitations = citations.filter((item) => retrievedChunkIds.has(item.chunkId));
  const supported = input.judgeDecisions.filter((decision) => decision.supported).length;
  const actualAbstained = proposal.action === "needs_human_review";

  return {
    schemaValid: true,
    categoryCorrect: proposal.category === expected.category,
    priorityCorrect: expected.priorities.includes(proposal.priority),
    actionCorrect: expected.actions.includes(proposal.action),
    abstentionCorrect: actualAbstained === expected.shouldAbstain,
    retrievalRecallAt5: ratio(relevantRetrieved.size, expected.relevantSourceIds.length),
    citationExistence: ratio(existingCitations.length, citations.length),
    citationSupport: ratio(supported, citations.length),
  };
}

export function failedExecutionScores(goldenCase: GoldenCase): CaseScores {
  return {
    schemaValid: false,
    categoryCorrect: false,
    priorityCorrect: false,
    actionCorrect: false,
    abstentionCorrect: false,
    retrievalRecallAt5: goldenCase.expected.relevantSourceIds.length > 0 ? 0 : null,
    citationExistence: null,
    citationSupport: null,
  };
}

function booleanMetric(values: readonly boolean[]): EvaluationMetric {
  const numerator = values.filter(Boolean).length;
  return { numerator, denominator: values.length, value: ratio(numerator, values.length) };
}

function optionalAverage(values: readonly (number | null)[]): EvaluationMetric {
  const scored = values.filter((value): value is number => value !== null);
  const numerator = scored.reduce((sum, value) => sum + value, 0);
  return {
    numerator,
    denominator: scored.length,
    value: ratio(numerator, scored.length),
  };
}

function abstentionMetric(
  results: readonly EvaluationCaseResult[],
  mode: "precision" | "recall",
): EvaluationMetric {
  const predicted = results.filter((result) => result.actual?.action === "needs_human_review");
  const expected = results.filter((result) => result.expected.shouldAbstain);
  const population = mode === "precision" ? predicted : expected;
  const numerator = population.filter(
    (result) => result.expected.shouldAbstain && result.actual?.action === "needs_human_review",
  ).length;
  return {
    numerator,
    denominator: population.length,
    value: ratio(numerator, population.length),
  };
}

export function aggregateQualityMetrics(
  results: readonly EvaluationCaseResult[],
): EvaluationQualityMetrics {
  return {
    schemaValidity: booleanMetric(results.map((result) => result.scores.schemaValid)),
    categoryAccuracy: booleanMetric(results.map((result) => result.scores.categoryCorrect)),
    priorityAccuracy: booleanMetric(results.map((result) => result.scores.priorityCorrect)),
    actionAccuracy: booleanMetric(results.map((result) => result.scores.actionCorrect)),
    retrievalRecallAt5: optionalAverage(results.map((result) => result.scores.retrievalRecallAt5)),
    citationExistence: optionalAverage(results.map((result) => result.scores.citationExistence)),
    citationSupport: optionalAverage(results.map((result) => result.scores.citationSupport)),
    abstentionAccuracy: booleanMetric(results.map((result) => result.scores.abstentionCorrect)),
    abstentionPrecision: abstentionMetric(results, "precision"),
    abstentionRecall: abstentionMetric(results, "recall"),
  };
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? 0;
}
