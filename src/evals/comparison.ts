import {
  EvaluationComparisonSchema,
  type EvaluationCaseOutcome,
  type EvaluationComparison,
  type EvaluationConfigDifference,
  type PersistedEvaluationCase,
  type PersistedEvaluationRun,
} from "@/evals/comparison-contracts";

export type EvaluationComparisonErrorCode =
  "same_run" | "incompatible_schema" | "incompatible_dataset" | "incompatible_cases";

export class EvaluationComparisonError extends Error {
  constructor(readonly code: EvaluationComparisonErrorCode) {
    super("The selected evaluation runs are not compatible.");
    this.name = "EvaluationComparisonError";
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

function display(value: unknown): string {
  return typeof value === "string" ? value : stable(value);
}

function difference(
  field: string,
  label: string,
  baseline: unknown,
  candidate: unknown,
): EvaluationConfigDifference | null {
  if (stable(baseline) === stable(candidate)) return null;
  return { field, label, baseline: display(baseline), candidate: display(candidate) };
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

function numericDelta(baseline: number | null, candidate: number | null) {
  return {
    baseline,
    candidate,
    delta: baseline === null || candidate === null ? null : candidate - baseline,
  };
}

function qualityDelta(
  baseline: PersistedEvaluationRun["metrics"]["quality"]["schemaValidity"],
  candidate: PersistedEvaluationRun["metrics"]["quality"]["schemaValidity"],
) {
  return { baseline, candidate, delta: numericDelta(baseline.value, candidate.value).delta };
}

function totalTokens(item: PersistedEvaluationCase): number {
  return (
    item.telemetry.generationInputTokens +
    item.telemetry.generationOutputTokens +
    item.telemetry.judgeInputTokens +
    item.telemetry.judgeOutputTokens
  );
}

function caseChanges(
  baseline: PersistedEvaluationCase,
  candidate: PersistedEvaluationCase,
): string[] {
  const changes: string[] = [];
  if (baseline.passed !== candidate.passed) changes.push("pass state");
  if (stable(baseline.actual) !== stable(candidate.actual)) changes.push("actual result");
  if (stable(baseline.scores) !== stable(candidate.scores)) changes.push("grader scores");
  if (stable(baseline.error) !== stable(candidate.error)) changes.push("error");
  if (stable(baseline.telemetry) !== stable(candidate.telemetry)) changes.push("telemetry");
  return changes;
}

function outcome(
  baseline: PersistedEvaluationCase,
  candidate: PersistedEvaluationCase,
  changes: readonly string[],
): EvaluationCaseOutcome {
  if (baseline.passed && !candidate.passed) return "regressed";
  if (!baseline.passed && candidate.passed) return "improved";
  return changes.length === 0 ? "unchanged" : "changed";
}

function assertCompatible(
  baseline: PersistedEvaluationRun,
  candidate: PersistedEvaluationRun,
): void {
  if (baseline.runId === candidate.runId) throw new EvaluationComparisonError("same_run");
  if (baseline.schemaVersion !== candidate.schemaVersion) {
    throw new EvaluationComparisonError("incompatible_schema");
  }
  if (
    baseline.dataset.version !== candidate.dataset.version ||
    baseline.dataset.sha256 !== candidate.dataset.sha256
  ) {
    throw new EvaluationComparisonError("incompatible_dataset");
  }
  const baselineIds = baseline.cases.map((item) => item.caseId).sort();
  const candidateIds = candidate.cases.map((item) => item.caseId).sort();
  if (stable(baselineIds) !== stable(candidateIds)) {
    throw new EvaluationComparisonError("incompatible_cases");
  }
}

export function compareEvaluationRuns(
  baseline: PersistedEvaluationRun,
  candidate: PersistedEvaluationRun,
): EvaluationComparison {
  assertCompatible(baseline, candidate);

  const versionDifferences = compact([
    difference("model", "Generation model", baseline.runtime.model, candidate.runtime.model),
    difference("judgeModel", "Citation judge model", baseline.judgeModel, candidate.judgeModel),
    difference(
      "prompt.classification",
      "Classification prompt",
      baseline.runtime.promptVersions.classification,
      candidate.runtime.promptVersions.classification,
    ),
    difference(
      "prompt.resolution",
      "Resolution prompt",
      baseline.runtime.promptVersions.resolution,
      candidate.runtime.promptVersions.resolution,
    ),
    difference(
      "prompt.citationJudge",
      "Citation judge prompt",
      baseline.runtime.promptVersions.citationJudge,
      candidate.runtime.promptVersions.citationJudge,
    ),
  ]);
  const configurationDifferences = compact([
    difference("provider", "Provider", baseline.runtime.provider, candidate.runtime.provider),
    difference(
      "retrieval",
      "Retrieval configuration",
      baseline.runtime.retrieval,
      candidate.runtime.retrieval,
    ),
    difference(
      "resolutionPolicy",
      "Resolution policy",
      baseline.runtime.resolutionPolicy,
      candidate.runtime.resolutionPolicy,
    ),
    difference(
      "thresholdVersion",
      "Threshold version",
      baseline.thresholdVersion,
      candidate.thresholdVersion,
    ),
    difference(
      "thresholds",
      "Thresholds",
      baseline.thresholds.map(({ metric, threshold }) => ({ metric, threshold })),
      candidate.thresholds.map(({ metric, threshold }) => ({ metric, threshold })),
    ),
    difference("pricing", "Pricing", baseline.runtime.pricing, candidate.runtime.pricing),
    difference(
      "concurrency",
      "Concurrency",
      baseline.runtime.concurrency,
      candidate.runtime.concurrency,
    ),
  ]);

  const qualityKeys = [
    "schemaValidity",
    "categoryAccuracy",
    "priorityAccuracy",
    "actionAccuracy",
    "retrievalRecallAt5",
    "citationExistence",
    "citationSupport",
    "abstentionAccuracy",
    "abstentionPrecision",
    "abstentionRecall",
  ] as const;
  const quality = Object.fromEntries(
    qualityKeys.map((key) => [
      key,
      qualityDelta(baseline.metrics.quality[key], candidate.metrics.quality[key]),
    ]),
  );
  const operationKeys = [
    "latencyP50Ms",
    "latencyP95Ms",
    "generationInputTokens",
    "generationOutputTokens",
    "judgeInputTokens",
    "judgeOutputTokens",
    "retryCount",
    "errorCount",
    "estimatedCostUsd",
  ] as const;
  const operations = Object.fromEntries(
    operationKeys.map((key) => [
      key,
      numericDelta(baseline.metrics.operations[key], candidate.metrics.operations[key]),
    ]),
  );

  const candidateCases = new Map(candidate.cases.map((item) => [item.caseId, item]));
  const cases = [...baseline.cases]
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .map((baselineCase) => {
      const candidateCase = candidateCases.get(baselineCase.caseId);
      if (!candidateCase) throw new EvaluationComparisonError("incompatible_cases");
      const changes = caseChanges(baselineCase, candidateCase);
      return {
        caseId: baselineCase.caseId,
        tags: candidateCase.tags,
        outcome: outcome(baselineCase, candidateCase, changes),
        changes,
        baseline: baselineCase,
        candidate: candidateCase,
        latencyDeltaMs: candidateCase.telemetry.latencyMs - baselineCase.telemetry.latencyMs,
        tokenDelta: totalTokens(candidateCase) - totalTokens(baselineCase),
      };
    });

  const { cases: _baselineCases, ...baselineSummary } = baseline;
  const { cases: _candidateCases, ...candidateSummary } = candidate;
  void _baselineCases;
  void _candidateCases;
  return EvaluationComparisonSchema.parse({
    baseline: baselineSummary,
    candidate: candidateSummary,
    versionDifferences,
    configurationDifferences,
    quality,
    operations,
    caseSummary: {
      regressed: cases.filter((item) => item.outcome === "regressed").length,
      improved: cases.filter((item) => item.outcome === "improved").length,
      changed: cases.filter((item) => item.outcome === "changed").length,
      unchanged: cases.filter((item) => item.outcome === "unchanged").length,
    },
    cases,
  });
}
