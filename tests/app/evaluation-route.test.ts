import { beforeAll, describe, expect, it, vi } from "vitest";

import { createEvaluationRunHandler } from "@/app/api/evaluations/run/route";
import type { EvaluationReport } from "@/evals/contracts";
import { EvaluationSetupError } from "@/evals/errors";
import type { AppLogger } from "@/observability/logger";
import { evaluationTraceId, makeEvaluationReport } from "../support/evaluation";

let report: EvaluationReport;

beforeAll(async () => {
  report = await makeEvaluationReport();
});

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
}

function request(body: string, contentType = "application/json") {
  return new Request("http://localhost/api/evaluations/run", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("POST /api/evaluations/run", () => {
  it("returns a threshold regression as valid non-cacheable report data without auth", async () => {
    const regression = {
      ...report,
      status: "regression" as const,
      thresholds: report.thresholds.map((item, index) =>
        index === 0 ? { ...item, passed: false, actual: 0.5 } : item,
      ),
    };
    const response = await createEvaluationRunHandler({
      run: vi.fn().mockResolvedValue(regression),
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(request(JSON.stringify({ concurrency: 3 })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      traceId: evaluationTraceId,
      data: { status: "regression", dataset: { caseCount: 30 } },
    });
  });

  it.each([
    ["{", "application/json", 400],
    [JSON.stringify({ concurrency: 0 }), "application/json", 400],
    [JSON.stringify({ concurrency: 3, extra: true }), "application/json", 400],
    [JSON.stringify({ concurrency: 3 }), "text/plain", 415],
  ])("strictly rejects invalid requests", async (body, contentType, status) => {
    const run = vi.fn();
    const response = await createEvaluationRunHandler({
      run,
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(request(body, contentType));
    expect(response.status).toBe(status);
    expect(run).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects an overlapping in-process run with 409", async () => {
    let finish!: (value: EvaluationReport) => void;
    const pending = new Promise<EvaluationReport>((resolve) => { finish = resolve; });
    const handler = createEvaluationRunHandler({
      run: () => pending,
      createTraceId: () => evaluationTraceId,
      log: logger(),
    });
    const first = handler(request(JSON.stringify({ concurrency: 3 })));
    const second = await handler(request(JSON.stringify({ concurrency: 2 })));
    expect(second.status).toBe(409);
    finish(report);
    expect((await first).status).toBe(200);
  });

  it("maps setup errors without leaking their details", async () => {
    const response = await createEvaluationRunHandler({
      run: vi.fn().mockRejectedValue(
        new EvaluationSetupError("configuration", "ANTHROPIC_API_KEY=secret"),
      ),
      createTraceId: () => evaluationTraceId,
      log: logger(),
    })(request(JSON.stringify({ concurrency: 3 })));
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("configuration_error");
    expect(body).not.toContain("ANTHROPIC_API_KEY");
    expect(body).not.toContain("secret");
  });
});
