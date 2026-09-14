import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { EvaluationReport } from "@/evals/contracts";
import { makeEvaluationReport } from "../support/evaluation";

const runIds = ["51111111-1111-4111-8111-111111111111", "52222222-2222-4222-8222-222222222222"];

function isolatedTestUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (!databaseName.endsWith("_test") || databaseName.length <= 5) {
    throw new Error("Integration tests require a database name ending in _test.");
  }
  return value;
}

function withIdentity(
  source: EvaluationReport,
  runId: string,
  completedAt: string,
): EvaluationReport {
  const report = structuredClone(source);
  report.runId = runId;
  report.startedAt = completedAt;
  report.completedAt = completedAt;
  return report;
}

describe("PostgreSQL evaluation history repository", () => {
  let baseline: EvaluationReport;
  let candidate: EvaluationReport;

  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedTestUrl();
    const [{ getDatabase }, { migrate }] = await Promise.all([
      import("@/db/client"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    await migrate(getDatabase(), { migrationsFolder: "drizzle" });
    const { deleteEvaluationRunsByIds } = await import("@/db/evaluation-runs");
    await deleteEvaluationRunsByIds(runIds);
    const report = await makeEvaluationReport();
    baseline = withIdentity(report, runIds[0]!, "2026-01-01T00:00:00.000Z");
    candidate = withIdentity(report, runIds[1]!, "2026-01-02T00:00:00.000Z");
    candidate.runtime.model = "candidate-model";
  });

  afterAll(async () => {
    const [{ deleteEvaluationRunsByIds }, { closeDatabase }] = await Promise.all([
      import("@/db/evaluation-runs"),
      import("@/db/client"),
    ]);
    await deleteEvaluationRunsByIds(runIds);
    await closeDatabase();
  });

  it("persists a run and all compact cases transactionally and idempotently", async () => {
    const { getDatabase } = await import("@/db/client");
    const { evaluationResults } = await import("@/db/schema");
    const { persistEvaluationReport } = await import("@/db/evaluation-runs");

    await expect(persistEvaluationReport(baseline)).resolves.toBe("created");
    await expect(persistEvaluationReport(baseline)).resolves.toBe("existing");
    const rows = await getDatabase()
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.evaluationRunId, baseline.runId));
    expect(rows).toHaveLength(baseline.dataset.caseCount);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("ticket");
    expect(serialized).not.toContain("expected");
    expect(serialized).not.toContain("suggestedResponse");
    expect(serialized).not.toContain("rationale");

    const conflict = structuredClone(baseline);
    conflict.runtime.model = "conflicting-model";
    await expect(persistEvaluationReport(conflict)).rejects.toMatchObject({ code: "run_conflict" });
    const afterConflict = await getDatabase()
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.evaluationRunId, baseline.runId));
    expect(afterConflict).toHaveLength(baseline.dataset.caseCount);
  });

  it("lists deterministically and loads both runs with one case set each", async () => {
    const { listRecentEvaluationRuns, loadEvaluationRunPair, persistEvaluationReport } =
      await import("@/db/evaluation-runs");
    await expect(persistEvaluationReport(candidate)).resolves.toBe("created");

    const recent = await listRecentEvaluationRuns(50);
    const testRuns = recent.filter((run) => runIds.includes(run.runId));
    expect(testRuns.map((run) => run.runId)).toEqual([candidate.runId, baseline.runId]);
    const [loadedBaseline, loadedCandidate] = await loadEvaluationRunPair(
      baseline.runId,
      candidate.runId,
    );
    expect(loadedBaseline.runId).toBe(baseline.runId);
    expect(loadedCandidate.runId).toBe(candidate.runId);
    expect(loadedBaseline.cases).toHaveLength(baseline.dataset.caseCount);
    expect(loadedCandidate.cases).toHaveLength(candidate.dataset.caseCount);
    expect(loadedBaseline.cases.map((item) => item.caseId)).toEqual(
      [...loadedBaseline.cases.map((item) => item.caseId)].sort(),
    );
  });
});
