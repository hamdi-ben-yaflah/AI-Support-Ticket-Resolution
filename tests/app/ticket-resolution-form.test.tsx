// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TicketResolutionForm } from "@/app/ticket-resolution-form";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
afterEach(() => vi.unstubAllGlobals());

describe("TicketResolutionForm", () => {
  it("prevents empty and short input and explains the boundary", async () => {
    const user = userEvent.setup();
    render(<TicketResolutionForm />);
    const button = screen.getByRole("button", { name: "Resolve ticket" });
    const textarea = screen.getByRole("textbox", { name: /ticket text/i });
    expect(button).toBeDisabled();
    await user.type(textarea, "too short");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("at least 10 characters");
  });

  it("prevents duplicate submission and renders the validated reply and citations", async () => {
    const user = userEvent.setup();
    let resolveJson!: (value: unknown) => void;
    const json = new Promise((resolve) => { resolveJson = resolve; });
    const fetchMock = vi.fn().mockResolvedValue({ json: () => json });
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketResolutionForm />);
    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "I was charged for both plans.");
    await user.selectOptions(screen.getByRole("combobox", { name: /customer tier/i }), "premium");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(screen.getByRole("button", { name: /resolving/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Resolving the ticket");
    fireEvent.submit(screen.getByRole("button", { name: /resolving/i }).closest("form")!);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveJson({ ok: true, traceId, data: { category: "billing", priority: "medium", summary: "Customer reports charges for both plans.", confidence: 0.89, groundedReply: { suggestedResponse: "I’m sorry about the duplicate charge. We can submit this for review.", citations: [{ chunkId: "223e4567-e89b-42d3-a456-426614174000", sourceId: "duplicate-charges", section: "Duplicate charges > When both charges settled", claim: "Duplicate settled charges can be reviewed." }] } } });
    expect(await screen.findByText(/submit this for review/)).toBeInTheDocument();
    expect(screen.getByText("Draft · not sent")).toBeInTheDocument();
    expect(screen.getByText("duplicate-charges")).toBeInTheDocument();
    expect(screen.getByText("Duplicate settled charges can be reviewed.")).toBeInTheDocument();
    expect(screen.getByText(`Trace ${traceId}`)).toBeInTheDocument();
  });

  it.each([["retrieval_unavailable", "temporarily unavailable", "Try resolution again"], ["insufficient_evidence", "enough evidence", undefined], ["model_output_invalid", "did not pass validation", undefined]] as const)("renders controlled %s details", async (code, message, retryLabel) => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: false, traceId, error: { code, message: "unsafe upstream detail", retryable: Boolean(retryLabel) } }) }));
    render(<TicketResolutionForm />);
    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "The product will not start.");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(traceId);
    expect(alert).not.toHaveTextContent("unsafe upstream detail");
    if (retryLabel) expect(screen.getByRole("button", { name: retryLabel })).toBeEnabled();
  });

  it("rejects a malformed success response", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: true, traceId, data: { category: "billing" } }) }));
    render(<TicketResolutionForm />);
    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "A sufficiently long ticket.");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  });
});
