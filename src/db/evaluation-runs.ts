import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db/client";
import { evaluationResults, evaluationRuns } from "@/db/schema";
import {
  EvaluationRunSummarySchema,
  PersistedEvaluationCaseSchema,
  PersistedEvaluationRunSchema,
  type EvaluationRunSummary,
  type PersistedEvaluationCase,
  type PersistedEvaluationRun,
} from "@/evals/comparison-contracts";
import { EvaluationReportSchema, type EvaluationReport } from "@/evals/contracts";
import { reportToPersistedRun } from "@/evals/persistence";

export type EvaluationRepositoryErrorCode =
  "not_found" | "invalid_data" | "run_conflict" | "unavailable";

export class EvaluationRepositoryError extends Error {
  constructor(
    readonly code: EvaluationRepositoryErrorCode,
    cause?: unknown,
  ) {
    super("Evaluation history is unavailable.", { cause });
    this.name = "EvaluationRepositoryError";
  }
}

const LimitSchema = z.number().int().min(1).max(50);
const RunIdsSchema = z
  .array(z.string().uuid())
  .length(2)
  .refine((ids) => ids[0] !== ids[1]);

type RunRow = typeof evaluationRuns.$inferSelect;
type CaseRow = typeof evaluationResults.$inferSelect;

function summaryFromRow(row: RunRow): EvaluationRunSummary {
  return EvaluationRunSummarySchema.parse({
    runId: row.id,
    schemaVersion: row.schemaVersion,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    dataset: {
      version: row.datasetVersion,
      sha256: row.datasetHash,
      caseCount: row.datasetCaseCount,
    },
    runtime: {
      provider: row.provider,
      model: row.generationModel,
      promptVersions: row.promptVersions,
      retrieval: row.retrievalConfig,
      resolutionPolicy: row.resolutionPolicy,
      concurrency: row.concurrency,
      pricing: row.pricing ?? null,
    },
    judgeModel: row.judgeModel,
    metrics: row.summary,
    thresholdVersion: row.thresholdVersion,
    thresholds: row.thresholds,
  });
}

function caseFromRow(row: CaseRow): PersistedEvaluationCase {
  return PersistedEvaluationCaseSchema.parse({
    caseId: row.caseId,
    tags: row.tags,
    actual: row.actual ?? null,
    scores: row.scores,
    telemetry: {
      latencyMs: row.latencyMs,
      generationInputTokens: row.generationInputTokens,
      generationOutputTokens: row.generationOutputTokens,
      judgeInputTokens: row.judgeInputTokens,
      judgeOutputTokens: row.judgeOutputTokens,
      retryCount: row.retryCount,
    },
    error: row.error ?? null,
    passed: row.passed,
  });
}

function assembleRun(row: RunRow, rows: readonly CaseRow[]): PersistedEvaluationRun {
  return PersistedEvaluationRunSchema.parse({
    ...summaryFromRow(row),
    cases: rows
      .filter((item) => item.evaluationRunId === row.id)
      .map(caseFromRow)
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  });
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

function equivalent(left: PersistedEvaluationRun, right: PersistedEvaluationRun): boolean {
  return stable(left) === stable(right);
}

function valuesForRun(run: PersistedEvaluationRun) {
  return {
    id: run.runId,
    schemaVersion: run.schemaVersion,
    status: run.status,
    datasetVersion: run.dataset.version,
    datasetHash: run.dataset.sha256,
    datasetCaseCount: run.dataset.caseCount,
    provider: run.runtime.provider,
    generationModel: run.runtime.model,
    judgeModel: run.judgeModel,
    promptVersions: run.runtime.promptVersions,
    retrievalConfig: run.runtime.retrieval,
    resolutionPolicy: run.runtime.resolutionPolicy,
    concurrency: run.runtime.concurrency,
    pricing: run.runtime.pricing,
    thresholdVersion: run.thresholdVersion,
    thresholds: run.thresholds,
    summary: run.metrics,
    startedAt: new Date(run.startedAt),
    completedAt: new Date(run.completedAt),
  };
}

function valuesForCases(run: PersistedEvaluationRun) {
  return run.cases.map((item) => ({
    evaluationRunId: run.runId,
    caseId: item.caseId,
    tags: item.tags,
    actual: item.actual,
    scores: item.scores,
    passed: item.passed,
    latencyMs: item.telemetry.latencyMs,
    generationInputTokens: item.telemetry.generationInputTokens,
    generationOutputTokens: item.telemetry.generationOutputTokens,
    judgeInputTokens: item.telemetry.judgeInputTokens,
    judgeOutputTokens: item.telemetry.judgeOutputTokens,
    retryCount: item.telemetry.retryCount,
    error: item.error,
  }));
}

export async function persistEvaluationReport(
  raw: EvaluationReport,
): Promise<"created" | "existing"> {
  const report = EvaluationReportSchema.parse(raw);
  const run = reportToPersistedRun(report);
  try {
    return await getDatabase().transaction(async (transaction) => {
      const inserted = await transaction
        .insert(evaluationRuns)
        .values(valuesForRun(run))
        .onConflictDoNothing({ target: evaluationRuns.id })
        .returning({ id: evaluationRuns.id });

      if (inserted.length > 0) {
        await transaction.insert(evaluationResults).values(valuesForCases(run));
        return "created" as const;
      }

      const [storedRun] = await transaction
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.id, run.runId));
      const storedCases = await transaction
        .select()
        .from(evaluationResults)
        .where(eq(evaluationResults.evaluationRunId, run.runId));
      if (!storedRun || !equivalent(assembleRun(storedRun, storedCases), run)) {
        throw new EvaluationRepositoryError("run_conflict");
      }
      return "existing" as const;
    });
  } catch (error) {
    if (error instanceof EvaluationRepositoryError) throw error;
    throw new EvaluationRepositoryError("unavailable", error);
  }
}

export async function listRecentEvaluationRuns(limit = 20): Promise<EvaluationRunSummary[]> {
  const boundedLimit = LimitSchema.parse(limit);
  try {
    const rows = await getDatabase()
      .select()
      .from(evaluationRuns)
      .orderBy(desc(evaluationRuns.completedAt), desc(evaluationRuns.id))
      .limit(boundedLimit);
    return rows.map(summaryFromRow);
  } catch (error) {
    if (error instanceof z.ZodError) throw new EvaluationRepositoryError("invalid_data", error);
    throw new EvaluationRepositoryError("unavailable", error);
  }
}

export async function loadEvaluationRunPair(
  baselineId: string,
  candidateId: string,
): Promise<[PersistedEvaluationRun, PersistedEvaluationRun]> {
  const ids = RunIdsSchema.parse([baselineId, candidateId]);
  try {
    const [runRows, caseRows] = await Promise.all([
      getDatabase().select().from(evaluationRuns).where(inArray(evaluationRuns.id, ids)),
      getDatabase()
        .select()
        .from(evaluationResults)
        .where(inArray(evaluationResults.evaluationRunId, ids)),
    ]);
    const byId = new Map(runRows.map((row) => [row.id, row]));
    const baseline = byId.get(ids[0]);
    const candidate = byId.get(ids[1]);
    if (!baseline || !candidate) throw new EvaluationRepositoryError("not_found");
    return [assembleRun(baseline, caseRows), assembleRun(candidate, caseRows)];
  } catch (error) {
    if (error instanceof EvaluationRepositoryError) throw error;
    if (error instanceof z.ZodError) throw new EvaluationRepositoryError("invalid_data", error);
    throw new EvaluationRepositoryError("unavailable", error);
  }
}

export async function deleteEvaluationRunsByIds(runIds: readonly string[]): Promise<void> {
  if (runIds.length === 0) return;
  const ids = z.array(z.string().uuid()).max(100).parse(runIds);
  await getDatabase().delete(evaluationRuns).where(inArray(evaluationRuns.id, ids));
}
