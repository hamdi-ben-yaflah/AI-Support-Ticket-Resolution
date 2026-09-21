import { EvaluationReportSchema, type EvaluationReport } from "@/evals/contracts";
import {
  PersistedEvaluationRunSchema,
  type PersistedEvaluationRun,
} from "@/evals/comparison-contracts";

export function reportToPersistedRun(raw: EvaluationReport): PersistedEvaluationRun {
  const report = EvaluationReportSchema.parse(raw);
  return PersistedEvaluationRunSchema.parse({
    runId: report.runId,
    schemaVersion: report.schemaVersion,
    status: report.status,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    dataset: report.dataset,
    runtime: report.runtime,
    judgeModel: report.runtime.models?.judge ?? report.runtime.model ?? "legacy",
    metrics: report.metrics,
    thresholdVersion: report.thresholdVersion,
    thresholds: report.thresholds,
    cases: report.cases
      .map((item) => ({
        caseId: item.caseId,
        tags: item.tags,
        actual: item.actual,
        scores: item.scores,
        telemetry: item.telemetry,
        error: item.error,
        passed: item.passed,
      }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  });
}
