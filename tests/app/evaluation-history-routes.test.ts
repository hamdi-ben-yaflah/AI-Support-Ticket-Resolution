import { beforeAll, describe, expect, it, vi } from "vitest";

import { createEvaluationCompareHandler } from "@/app/api/evaluations/compare/route";
import { createEvaluationRunsHandler } from "@/app/api/evaluations/runs/route";
import { EvaluationRepositoryError } from "@/db/evaluation-runs";
import type { AppLogger } from "@/observability/logger";
import { EvaluationComparisonError } from "@/evals/comparison";
import { reportToPersistedRun } from "@/evals/persistence";
import type { PersistedEvaluationRun } from "@/evals/comparison-contracts";
import { evaluationTraceId, makeEvaluationReport } from "../support/evaluation";

let baseline: PersistedEvaluationRun;
let candidate: PersistedEvaluationRun;

beforeAll(async () => {
  baseline = reportToPersistedRun(await makeEvaluationReport());
  candidate = structuredClone(baseline);
  candidate.runId = "323e4567-e89b-42d3-a456-426614174000";
  candidate.runtime.model = "candidate-model";
});

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
}

describe("GET /api/evaluations/runs", () => {
  it("returns a non-revealing 404 when live evaluations are disabled", async () => {
    const list = vi.fn();
    const response = await createEvaluationRunsHandler({
      list,
      isEnabled: () => false,
    })(new Request("http://localhost/api/evaluations/runs"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
    expect(list).not.toHaveBeenCalled();
  });

  it("returns bounded safe summaries without caching", async () => {
    const { cases, ...summary } = baseline;
    expect(cases).toHaveLength(30);
    const list = vi.fn().mockResolvedValue([summary]);
    const response = await createEvaluationRunsHandler({
      list,
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(new Request("http://localhost/api/evaluations/runs?limit=5"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(list).toHaveBeenCalledWith(5);
    const body = await response.text();
    expect(body).not.toContain("suggestedResponse");
    expect(body).not.toContain("cases");
  });

  it.each(["0", "51", "1.5", "x", "1&extra=true", "1&limit=2"])(
    "rejects invalid or ambiguous limit %s",
    async (query) => {
      const list = vi.fn();
      const response = await createEvaluationRunsHandler({
        list,
        createTraceId: () => evaluationTraceId,
      })(new Request(`http://localhost/api/evaluations/runs?limit=${query}`));
      expect(response.status).toBe(400);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("maps unavailable storage without leaking details", async () => {
    const response = await createEvaluationRunsHandler({
      list: vi
        .fn()
        .mockRejectedValue(new EvaluationRepositoryError("unavailable", "DATABASE_URL=secret")),
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(new Request("http://localhost/api/evaluations/runs"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("configuration_error");
    expect(body).not.toContain("secret");
  });
});

describe("GET /api/evaluations/compare", () => {
  const url = () =>
    `http://localhost/api/evaluations/compare?baseline=${baseline.runId}&candidate=${candidate.runId}`;

  it("returns a non-revealing 404 when live evaluations are disabled", async () => {
    const load = vi.fn();
    const response = await createEvaluationCompareHandler({
      load,
      isEnabled: () => false,
    })(new Request(url()));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("returns a validated non-cacheable comparison", async () => {
    const response = await createEvaluationCompareHandler({
      load: vi.fn().mockResolvedValue([baseline, candidate]),
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(new Request(url()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { baseline: { runId: baseline.runId }, candidate: { runId: candidate.runId } },
    });
  });

  it("strictly validates UUIDs, distinct runs, duplicates, and unknown fields", async () => {
    const load = vi.fn();
    for (const query of [
      "baseline=nope&candidate=nope",
      `baseline=${baseline.runId}&candidate=${baseline.runId}`,
      `baseline=${baseline.runId}&candidate=${candidate.runId}&extra=true`,
      `baseline=${baseline.runId}&baseline=${candidate.runId}&candidate=${candidate.runId}`,
    ]) {
      const response = await createEvaluationCompareHandler({
        load,
        createTraceId: () => evaluationTraceId,
      })(new Request(`http://localhost/api/evaluations/compare?${query}`));
      expect(response.status).toBe(400);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("distinguishes missing and incompatible runs", async () => {
    const missing = await createEvaluationCompareHandler({
      load: vi.fn().mockRejectedValue(new EvaluationRepositoryError("not_found")),
      createTraceId: () => evaluationTraceId,
    })(new Request(url()));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "evaluation_not_found" },
    });

    const incompatible = await createEvaluationCompareHandler({
      load: vi.fn().mockResolvedValue([baseline, candidate]),
      compare: vi.fn(() => {
        throw new EvaluationComparisonError("incompatible_dataset");
      }),
      createTraceId: () => evaluationTraceId,
    })(new Request(url()));
    expect(incompatible.status).toBe(409);
    await expect(incompatible.json()).resolves.toMatchObject({
      error: { code: "evaluation_incompatible" },
    });
  });
});
