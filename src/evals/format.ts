import type { EvaluationMetric, EvaluationReport } from "@/evals/contracts";

function percent(metric: EvaluationMetric): string {
  return metric.value === null ? "n/a" : `${(metric.value * 100).toFixed(1)}%`;
}

export function formatEvaluationSummary(report: EvaluationReport): string {
  const quality = report.metrics.quality;
  const lines = [
    `Evaluation ${report.status.toUpperCase()} · ${report.dataset.caseCount} cases · ${report.dataset.version}`,
    `schema ${percent(quality.schemaValidity)} | category ${percent(quality.categoryAccuracy)} | priority ${percent(quality.priorityAccuracy)} | retrieval@5 ${percent(quality.retrievalRecallAt5)} | citations ${percent(quality.citationSupport)} | abstention ${percent(quality.abstentionAccuracy)}`,
    `latency p50 ${report.metrics.operations.latencyP50Ms}ms | p95 ${report.metrics.operations.latencyP95Ms}ms | errors ${report.metrics.operations.errorCount} | retries ${report.metrics.operations.retryCount}`,
    ...report.thresholds.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.metric}: ${item.actual === null ? "n/a" : `${(item.actual * 100).toFixed(1)}%`} >= ${(item.threshold * 100).toFixed(1)}%`,
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
