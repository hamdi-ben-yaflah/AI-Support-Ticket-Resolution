import type { EvaluationMetric, EvaluationReport } from "@/evals/contracts";

function percent(metric: EvaluationMetric): string {
  if (metric.value === null) return "n/a";
  const actual = metric.value.toFixed(3);
  return metric.lowerBound === null || metric.upperBound === null
    ? actual
    : `${actual} (95% CI ${metric.lowerBound.toFixed(2)}–${metric.upperBound.toFixed(2)})`;
}

function cacheHitRate(operations: EvaluationReport["metrics"]["operations"]): string {
  const billedInputTokens =
    operations.generationInputTokens +
    operations.judgeInputTokens +
    operations.cacheWriteInputTokens;
  const total = operations.cachedInputTokens + billedInputTokens;
  return total === 0 ? "n/a" : `${((operations.cachedInputTokens / total) * 100).toFixed(1)}%`;
}

export function formatEvaluationSummary(report: EvaluationReport): string {
  const quality = report.metrics.quality;
  const lines = [
    `Evaluation ${report.status.toUpperCase()} · ${report.dataset.caseCount} cases · ${report.dataset.version}`,
    `schema ${percent(quality.schemaValidity)} | category ${percent(quality.categoryAccuracy)} | priority ${percent(quality.priorityAccuracy)} | retrieval@5 ${percent(quality.retrievalRecallAt5)} | citations ${percent(quality.citationSupport)} | abstention ${percent(quality.abstentionAccuracy)}`,
    `latency p50 ${report.metrics.operations.latencyP50Ms}ms | p95 ${report.metrics.operations.latencyP95Ms}ms | errors ${report.metrics.operations.errorCount} | retries ${report.metrics.operations.retryCount}`,
    `cache hit ${cacheHitRate(report.metrics.operations)} | cache read ${report.metrics.operations.cachedInputTokens} | cache write ${report.metrics.operations.cacheWriteInputTokens}`,
    ...report.thresholds.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.metric}: ${item.actual === null ? "n/a" : item.actual.toFixed(3)}${item.lowerBound === null ? "" : ` (lower 95% bound ${item.lowerBound.toFixed(3)})`} >= ${item.threshold.toFixed(3)}`,
    ),
  ];
  const failures = report.cases.filter((item) => !item.passed);
  if (failures.length > 0) {
    lines.push(
      `Failed cases (${failures.length}): ${failures
        .slice(0, 10)
        .map((item) => item.caseId)
        .join(", ")}${failures.length > 10 ? ", …" : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
