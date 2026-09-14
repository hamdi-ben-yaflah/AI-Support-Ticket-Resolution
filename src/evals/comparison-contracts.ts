import { z } from "zod";

import {
  EvaluationCaseErrorSchema,
  EvaluationCaseScoresSchema,
  EvaluationQualityMetricsSchema,
  EvaluationReportSchema,
} from "@/evals/contracts";

const RuntimeSchema = EvaluationReportSchema.shape.runtime;
const OperationsSchema = EvaluationReportSchema.shape.metrics.shape.operations;
const ThresholdSchema = EvaluationReportSchema.shape.thresholds.element;
const CompactActualSchema = EvaluationReportSchema.shape.cases.element.shape.actual;

export const EvaluationRunSummarySchema = z
  .object({
    runId: z.string().uuid(),
    schemaVersion: z.string().trim().min(1).max(120),
    status: EvaluationReportSchema.shape.status,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    dataset: z
      .object({
        version: z.string().trim().min(1).max(120),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        caseCount: z.number().int().min(1).max(50),
      })
      .strict(),
    runtime: RuntimeSchema,
    judgeModel: z.string().trim().min(1).max(200),
    metrics: z
      .object({
        quality: EvaluationQualityMetricsSchema,
        operations: OperationsSchema,
      })
      .strict(),
    thresholdVersion: z.string().trim().min(1).max(120),
    thresholds: z.array(ThresholdSchema),
  })
  .strict()
  .refine((value) => Date.parse(value.completedAt) >= Date.parse(value.startedAt), {
    path: ["completedAt"],
    message: "Completion time cannot precede start time.",
  });

export const PersistedEvaluationCaseSchema = z
  .object({
    caseId: EvaluationReportSchema.shape.cases.element.shape.caseId,
    tags: EvaluationReportSchema.shape.cases.element.shape.tags,
    actual: CompactActualSchema,
    scores: EvaluationCaseScoresSchema,
    telemetry: EvaluationReportSchema.shape.cases.element.shape.telemetry,
    error: EvaluationCaseErrorSchema.nullable(),
    passed: z.boolean(),
  })
  .strict();

export const PersistedEvaluationRunSchema = EvaluationRunSummarySchema.safeExtend({
  cases: z.array(PersistedEvaluationCaseSchema).min(1).max(50),
})
  .strict()
  .superRefine((value, context) => {
    const ids = value.cases.map((item) => item.caseId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["cases"], message: "Case IDs must be unique." });
    }
    if (value.dataset.caseCount !== value.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "Case count must match the dataset.",
      });
    }
  });

export const EvaluationRunListSchema = z
  .object({ runs: z.array(EvaluationRunSummarySchema).max(50) })
  .strict();

export const EvaluationComparisonRequestSchema = z
  .object({
    baseline: z.string().uuid(),
    candidate: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.baseline !== value.candidate, {
    message: "Baseline and candidate must be different runs.",
  });

const NullableNumberDeltaSchema = z
  .object({
    baseline: z.number().nullable(),
    candidate: z.number().nullable(),
    delta: z.number().nullable(),
  })
  .strict();

const QualityMetricDeltaSchema = z
  .object({
    baseline: EvaluationReportSchema.shape.metrics.shape.quality.shape.schemaValidity,
    candidate: EvaluationReportSchema.shape.metrics.shape.quality.shape.schemaValidity,
    delta: z.number().nullable(),
  })
  .strict();

export const EvaluationConfigDifferenceSchema = z
  .object({
    field: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    baseline: z.string().max(500),
    candidate: z.string().max(500),
  })
  .strict();

export const EvaluationCaseOutcomeSchema = z.enum([
  "regressed",
  "improved",
  "changed",
  "unchanged",
]);

export const EvaluationCaseComparisonSchema = z
  .object({
    caseId: PersistedEvaluationCaseSchema.shape.caseId,
    tags: PersistedEvaluationCaseSchema.shape.tags,
    outcome: EvaluationCaseOutcomeSchema,
    changes: z.array(z.string().min(1).max(120)).max(24),
    baseline: PersistedEvaluationCaseSchema,
    candidate: PersistedEvaluationCaseSchema,
    latencyDeltaMs: z.number().int(),
    tokenDelta: z.number().int(),
  })
  .strict();

const QualityDeltasSchema = z
  .object({
    schemaValidity: QualityMetricDeltaSchema,
    categoryAccuracy: QualityMetricDeltaSchema,
    priorityAccuracy: QualityMetricDeltaSchema,
    actionAccuracy: QualityMetricDeltaSchema,
    retrievalRecallAt5: QualityMetricDeltaSchema,
    citationExistence: QualityMetricDeltaSchema,
    citationSupport: QualityMetricDeltaSchema,
    abstentionAccuracy: QualityMetricDeltaSchema,
    abstentionPrecision: QualityMetricDeltaSchema,
    abstentionRecall: QualityMetricDeltaSchema,
  })
  .strict();

const OperationalDeltasSchema = z
  .object({
    latencyP50Ms: NullableNumberDeltaSchema,
    latencyP95Ms: NullableNumberDeltaSchema,
    generationInputTokens: NullableNumberDeltaSchema,
    generationOutputTokens: NullableNumberDeltaSchema,
    judgeInputTokens: NullableNumberDeltaSchema,
    judgeOutputTokens: NullableNumberDeltaSchema,
    retryCount: NullableNumberDeltaSchema,
    errorCount: NullableNumberDeltaSchema,
    estimatedCostUsd: NullableNumberDeltaSchema,
  })
  .strict();

export const EvaluationComparisonSchema = z
  .object({
    baseline: EvaluationRunSummarySchema,
    candidate: EvaluationRunSummarySchema,
    versionDifferences: z.array(EvaluationConfigDifferenceSchema).max(8),
    configurationDifferences: z.array(EvaluationConfigDifferenceSchema).max(24),
    quality: QualityDeltasSchema,
    operations: OperationalDeltasSchema,
    caseSummary: z
      .object({
        regressed: z.number().int().nonnegative(),
        improved: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
      })
      .strict(),
    cases: z.array(EvaluationCaseComparisonSchema).min(1).max(50),
  })
  .strict();

export type EvaluationRunSummary = z.infer<typeof EvaluationRunSummarySchema>;
export type PersistedEvaluationCase = z.infer<typeof PersistedEvaluationCaseSchema>;
export type PersistedEvaluationRun = z.infer<typeof PersistedEvaluationRunSchema>;
export type EvaluationComparison = z.infer<typeof EvaluationComparisonSchema>;
export type EvaluationCaseOutcome = z.infer<typeof EvaluationCaseOutcomeSchema>;
export type EvaluationConfigDifference = z.infer<typeof EvaluationConfigDifferenceSchema>;
