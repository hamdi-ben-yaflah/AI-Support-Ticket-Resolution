// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EvaluationHistory } from "@/app/admin/evaluations/evaluation-history";
import type { EvaluationComparison, PersistedEvaluationRun } from "@/evals/comparison-contracts";
import { compareEvaluationRuns } from "@/evals/comparison";
import { reportToPersistedRun } from "@/evals/persistence";
import { evaluationTraceId, makeEvaluationReport } from "../support/evaluation";

let baseline: PersistedEvaluationRun;
let candidate: PersistedEvaluationRun;
let comparison: EvaluationComparison;

beforeAll(async () => {
  baseline = reportToPersistedRun(await makeEvaluationReport());
  candidate = structuredClone(baseline);
  candidate.runId = "323e4567-e89b-42d3-a456-426614174000";
  candidate.completedAt = "2026-01-02T00:00:00.000Z";
  candidate.runtime.model = "candidate-model";
  candidate.judgeModel = "candidate-model";
  candidate.runtime.promptVersions.resolution = "resolve.v4";
  candidate.runtime.retrieval.minimumSimilarity = 0.7;
  candidate.metrics.operations.latencyP50Ms += 10;
  candidate.cases[0]!.passed = false;
  candidate.cases[0]!.scores.categoryCorrect = false;
  baseline.cases[1]!.passed = false;
  baseline.cases[1]!.scores.actionCorrect = false;
  comparison = compareEvaluationRuns(baseline, candidate);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function summaries() {
  const { cases: baselineCases, ...baselineSummary } = baseline;
  const { cases: candidateCases, ...candidateSummary } = candidate;
  expect(baselineCases).toHaveLength(30);
  expect(candidateCases).toHaveLength(30);
  return [candidateSummary, baselineSummary];
}

describe("EvaluationHistory", () => {
  it("loads compatible defaults and renders version, drift, deltas, and case filters", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve({
        status: 200,
        json: async () => url.startsWith("/api/evaluations/runs")
          ? { ok: true, traceId: evaluationTraceId, data: { runs: summaries() } }
          : { ok: true, traceId: evaluationTraceId, data: comparison },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EvaluationHistory refreshVersion={0} />);
    expect(await screen.findByText("Generation model:")).toBeInTheDocument();
    expect(screen.getAllByText(/fake-model → candidate-model/)).toHaveLength(2);
    expect(screen.getByText("Configuration drift may confound this comparison")).toBeInTheDocument();
    expect(screen.getByRole("caption", { name: "Quality metrics" })).toBeInTheDocument();
    expect(screen.getByRole("caption", { name: "Operational metrics" })).toBeInTheDocument();
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("eval-case-01")).toBeInTheDocument();
    expect(screen.queryByText("eval-case-02")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Improved" }));
    expect(screen.getByText("eval-case-02")).toBeInTheDocument();
    expect(screen.queryByText("eval-case-01")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/evaluations/compare?"))).toBe(true);
  });

  it("shows honest empty and malformed-history states", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true, traceId: evaluationTraceId, data: { runs: [] } }),
    }));
    const { unmount } = render(<EvaluationHistory refreshVersion={0} />);
    expect(await screen.findByText(/No saved runs yet/)).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, json: async () => ({ unsafe: true }) }));
    render(<EvaluationHistory refreshVersion={0} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  });

  it("explains incompatible selections without rendering unsafe API detail", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve({
      status: String(input).startsWith("/api/evaluations/runs") ? 200 : 409,
      json: async () => String(input).startsWith("/api/evaluations/runs")
        ? { ok: true, traceId: evaluationTraceId, data: { runs: summaries() } }
        : {
            ok: false,
            traceId: evaluationTraceId,
            error: {
              code: "evaluation_incompatible",
              message: "DATABASE_URL=secret",
              retryable: false,
            },
          },
    })));
    render(<EvaluationHistory refreshVersion={0} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("cannot be compared");
    expect(alert).not.toHaveTextContent("DATABASE_URL");
    expect(alert).not.toHaveTextContent("secret");
  });
});
