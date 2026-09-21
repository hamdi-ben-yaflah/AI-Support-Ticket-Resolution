import { z } from "zod";

import { CATEGORIES, PRIORITIES } from "@/domain/classification";
import { CUSTOMER_TIERS } from "@/domain/ticket";

export const EVALUATION_ACTIONS = ["reply", "request_refund_review", "needs_human_review"] as const;
export const EVALUATION_DATASET_VERSION = "golden.v2" as const;
export const EVALUATION_THRESHOLD_VERSION = "evaluation-thresholds.v1" as const;

const UniqueStringsSchema = z
  .array(z.string().trim().min(1).max(120))
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Values must be unique." });
    }
  });

export const GoldenCaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^eval-[a-z0-9-]+$/)
      .max(80),
    datasetVersion: z.literal(EVALUATION_DATASET_VERSION),
    ticket: z
      .object({
        text: z.string().trim().min(10).max(10_000),
        customerTier: z.enum(CUSTOMER_TIERS).optional(),
      })
      .strict(),
    expected: z
      .object({
        category: z.enum(CATEGORIES),
        priorities: z.array(z.enum(PRIORITIES)).min(1).max(PRIORITIES.length),
        actions: z.array(z.enum(EVALUATION_ACTIONS)).min(1).max(EVALUATION_ACTIONS.length),
        relevantSourceIds: UniqueStringsSchema.max(8),
        shouldAbstain: z.boolean(),
      })
      .strict(),
    tags: UniqueStringsSchema.min(1).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.expected.priorities).size !== value.expected.priorities.length) {
      context.addIssue({
        code: "custom",
        path: ["expected", "priorities"],
        message: "Expected priorities must be unique.",
      });
    }
    if (new Set(value.expected.actions).size !== value.expected.actions.length) {
      context.addIssue({
        code: "custom",
        path: ["expected", "actions"],
        message: "Expected actions must be unique.",
      });
    }
    const expectsReview = value.expected.actions.includes("needs_human_review");
    if (value.expected.shouldAbstain !== expectsReview) {
      context.addIssue({
        code: "custom",
        path: ["expected", "shouldAbstain"],
        message: "Abstention labels must agree with allowed actions.",
      });
    }
  });

export const EvaluationRunRequestSchema = z
  .object({
    concurrency: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const CitationJudgeDecisionSchema = z
  .object({
    citationId: z.string().uuid(),
    supported: z.boolean(),
    rationale: z.string().trim().min(1).max(300),
  })
  .strict();

export const CitationJudgeOutputSchema = z
  .object({
    decisions: z.array(CitationJudgeDecisionSchema).min(1).max(8),
  })
  .strict();

const ExpectedResultSchema = GoldenCaseSchema.shape.expected;

const CompactActualSchema = z
  .object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    confidence: z.number().min(0).max(1),
    action: z.enum(EVALUATION_ACTIONS),
    citedChunkIds: z.array(z.string().uuid()).max(8),
    citedSourceIds: UniqueStringsSchema.max(8),
    retrievedChunkIds: z.array(z.string().uuid()).max(8),
    retrievedSourceIds: UniqueStringsSchema.max(8),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    promptVersions: z
      .object({
        classification: z.string().trim().min(1).max(120),
        resolution: z.string().trim().min(1).max(120),
      })
      .strict(),
  })
  .strict();

export const EvaluationCaseScoresSchema = z
  .object({
    schemaValid: z.boolean(),
    categoryCorrect: z.boolean(),
    priorityCorrect: z.boolean(),
    actionCorrect: z.boolean(),
    abstentionCorrect: z.boolean(),
    retrievalRecallAt5: z.number().min(0).max(1).nullable(),
    citationExistence: z.number().min(0).max(1).nullable(),
    citationSupport: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const EvaluationCaseErrorSchema = z
  .object({
    stage: z.enum(["resolution", "judge"]),
    code: z.enum([
      "configuration",
      "timeout",
      "unavailable",
      "refused",
      "truncated",
      "invalid_output",
      "retrieval_unavailable",
      "unexpected",
    ]),
    message: z.string().trim().min(1).max(200),
  })
  .strict();

export const EvaluationCaseResultSchema = z
  .object({
    caseId: z
      .string()
      .regex(/^eval-[a-z0-9-]+$/)
      .max(80),
    tags: UniqueStringsSchema.min(1).max(12),
    expected: ExpectedResultSchema,
    actual: CompactActualSchema.nullable(),
    scores: EvaluationCaseScoresSchema,
    judgeDecisions: z.array(CitationJudgeDecisionSchema).max(8),
    telemetry: z
      .object({
        latencyMs: z.number().int().nonnegative(),
        generationInputTokens: z.number().int().nonnegative(),
        generationOutputTokens: z.number().int().nonnegative(),
        generationCachedInputTokens: z.number().int().nonnegative().default(0),
        generationCacheWriteTokens: z.number().int().nonnegative().default(0),
        judgeInputTokens: z.number().int().nonnegative(),
        judgeOutputTokens: z.number().int().nonnegative(),
        judgeCachedInputTokens: z.number().int().nonnegative().default(0),
        judgeCacheWriteTokens: z.number().int().nonnegative().default(0),
        retryCount: z.number().int().nonnegative(),
      })
      .strict(),
    error: EvaluationCaseErrorSchema.nullable(),
    passed: z.boolean(),
  })
  .strict();

export const EvaluationMetricSchema = z
  .object({
    value: z.number().min(0).max(1).nullable(),
    numerator: z.number().nonnegative(),
    denominator: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.numerator > value.denominator) {
      context.addIssue({ code: "custom", message: "Numerator cannot exceed denominator." });
    }
    if ((value.denominator === 0) !== (value.value === null)) {
      context.addIssue({
        code: "custom",
        message: "Metrics without a denominator must have a null value.",
      });
    }
  });

export const EvaluationQualityMetricsSchema = z
  .object({
    schemaValidity: EvaluationMetricSchema,
    categoryAccuracy: EvaluationMetricSchema,
    priorityAccuracy: EvaluationMetricSchema,
    actionAccuracy: EvaluationMetricSchema,
    retrievalRecallAt5: EvaluationMetricSchema,
    citationExistence: EvaluationMetricSchema,
    citationSupport: EvaluationMetricSchema,
    abstentionAccuracy: EvaluationMetricSchema,
    abstentionPrecision: EvaluationMetricSchema,
    abstentionRecall: EvaluationMetricSchema,
  })
  .strict();

export const ThresholdMetricSchema = z.enum([
  "schemaValidity",
  "categoryAccuracy",
  "retrievalRecallAt5",
  "citationSupport",
  "abstentionAccuracy",
]);

export const EvaluationReportSchema = z
  .object({
    schemaVersion: z.literal("evaluation-report.v1"),
    runId: z.string().uuid(),
    status: z.enum(["pass", "regression"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    dataset: z
      .object({
        version: z.literal(EVALUATION_DATASET_VERSION),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        caseCount: z.number().int().min(30).max(50),
      })
      .strict(),
    runtime: z
      .object({
        provider: z.string().trim().min(1).max(120),
        model: z.string().trim().min(1).max(200),
        promptVersions: z
          .object({
            classification: z.string().trim().min(1).max(120),
            resolution: z.string().trim().min(1).max(120),
            citationJudge: z.string().trim().min(1).max(120),
          })
          .strict(),
        retrieval: z
          .object({
            version: z.string().trim().min(1).max(120),
            candidateCount: z.number().int().min(1).max(50),
            finalCount: z.number().int().min(1).max(8),
            minimumSimilarity: z.number().min(-1).max(1),
            maximumContextTokens: z.number().int().positive(),
            minimumEvidenceCount: z.number().int().min(1).max(8),
          })
          .strict(),
        resolutionPolicy: z
          .object({
            version: z.string().trim().min(1).max(120),
            minimumConfidence: z.number().min(0).max(1),
          })
          .strict(),
        concurrency: z.number().int().min(1).max(5),
        pricing: z
          .object({
            inputUsdPerMillion: z.number().nonnegative(),
            outputUsdPerMillion: z.number().nonnegative(),
            cacheReadUsdPerMillion: z.number().nonnegative().default(0),
            cacheWriteUsdPerMillion: z.number().nonnegative().default(0),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    metrics: z
      .object({
        quality: EvaluationQualityMetricsSchema,
        operations: z
          .object({
            latencyP50Ms: z.number().int().nonnegative(),
            latencyP95Ms: z.number().int().nonnegative(),
            generationInputTokens: z.number().int().nonnegative(),
            generationOutputTokens: z.number().int().nonnegative(),
            judgeInputTokens: z.number().int().nonnegative(),
            judgeOutputTokens: z.number().int().nonnegative(),
            cachedInputTokens: z.number().int().nonnegative().default(0),
            cacheWriteInputTokens: z.number().int().nonnegative().default(0),
            averageGenerationInputTokens: z.number().nonnegative(),
            averageGenerationOutputTokens: z.number().nonnegative(),
            averageJudgeInputTokens: z.number().nonnegative(),
            averageJudgeOutputTokens: z.number().nonnegative(),
            retryCount: z.number().int().nonnegative(),
            errorCount: z.number().int().nonnegative(),
            estimatedCostUsd: z.number().nonnegative().nullable(),
          })
          .strict(),
      })
      .strict(),
    thresholdVersion: z.literal(EVALUATION_THRESHOLD_VERSION),
    thresholds: z.array(
      z
        .object({
          metric: ThresholdMetricSchema,
          threshold: z.number().min(0).max(1),
          actual: z.number().min(0).max(1).nullable(),
          passed: z.boolean(),
        })
        .strict(),
    ),
    cases: z.array(EvaluationCaseResultSchema).min(30).max(50),
  })
  .strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type CitationJudgeDecision = z.infer<typeof CitationJudgeDecisionSchema>;
export type CitationJudgeOutput = z.infer<typeof CitationJudgeOutputSchema>;
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResultSchema>;
export type EvaluationMetric = z.infer<typeof EvaluationMetricSchema>;
export type EvaluationQualityMetrics = z.infer<typeof EvaluationQualityMetricsSchema>;
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
export type EvaluationRunRequest = z.infer<typeof EvaluationRunRequestSchema>;
