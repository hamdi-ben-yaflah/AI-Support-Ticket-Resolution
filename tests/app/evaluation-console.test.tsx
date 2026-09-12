// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { EvaluationConsole } from "@/app/admin/evaluations/evaluation-console";
import type { EvaluationReport } from "@/evals/contracts";
import { evaluationTraceId, makeEvaluationReport } from "../support/evaluation";

let report: EvaluationReport;

beforeAll(async () => {
  report = await makeEvaluationReport();
});

describe("EvaluationConsole", () => {
  it("disables duplicate submissions, renders metrics, filters cases, and downloads JSON", async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    const json = new Promise((resolve) => { finish = resolve; });
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: () => json });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn().mockReturnValue("blob:report");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<EvaluationConsole />);
    await user.click(screen.getByRole("button", { name: "Run evaluation" }));
    expect(screen.getByRole("button", { name: /running evaluation/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /running evaluation/i }));
    expect(fetchMock).toHaveBeenCalledOnce();
    finish({ ok: true, traceId: evaluationTraceId, data: report });

    expect(await screen.findByText("Quality gate passed")).toBeInTheDocument();
    expect(screen.getAllByText("Schema validity")).toHaveLength(2);
    expect(screen.getByText("P95 latency")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Failed cases" }));
    expect(screen.getByText("No failed cases in this report.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download JSON report" }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows overlap and malformed response failures safely", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        ok: false,
        traceId: evaluationTraceId,
        error: { code: "invalid_request", message: "unsafe", retryable: true },
      }),
    }));
    const { unmount } = render(<EvaluationConsole />);
    await user.click(screen.getByRole("button", { name: "Run evaluation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already running");
    expect(screen.getByRole("alert")).not.toHaveTextContent("unsafe");
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, json: async () => ({ ok: true }) }));
    render(<EvaluationConsole />);
    await user.click(screen.getByRole("button", { name: "Run evaluation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    vi.unstubAllGlobals();
  });
});
