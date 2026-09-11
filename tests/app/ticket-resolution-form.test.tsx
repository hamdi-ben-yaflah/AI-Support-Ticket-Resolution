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
    const chunkId = "223e4567-e89b-42d3-a456-426614174000";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: () => json })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          traceId,
          data: {
            chunkId,
            sourceId: "duplicate-charges",
            title: "Duplicate plan charges",
            section: "Duplicate charges > When both charges settled",
            content: "Settled duplicate charges can be submitted for review.",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketResolutionForm />);
    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "I was charged for both plans.");
    await user.selectOptions(screen.getByRole("combobox", { name: /customer tier/i }), "premium");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(screen.getByRole("button", { name: /resolving/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Resolving the ticket");
    fireEvent.submit(screen.getByRole("button", { name: /resolving/i }).closest("form")!);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveJson({ ok: true, traceId, data: { category: "billing", priority: "medium", summary: "Customer reports charges for both plans.", confidence: 0.89, groundedReply: { suggestedResponse: "I’m sorry about the duplicate charge. We can submit this for review.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Duplicate charges > When both charges settled", claim: "Duplicate settled charges can be reviewed." }] } } });
    expect(await screen.findByText(/submit this for review/)).toBeInTheDocument();
    expect(screen.getByText("Draft · not sent")).toBeInTheDocument();
    expect(await screen.findByText("Duplicate plan charges")).toBeInTheDocument();
    expect(screen.getByText("Settled duplicate charges can be submitted for review.")).toBeInTheDocument();
    expect(screen.getByText("Retrieved evidence")).toBeInTheDocument();
    expect(screen.getByText("Generated support claim")).toBeInTheDocument();
    expect(screen.getByText("Duplicate settled charges can be reviewed.")).toBeInTheDocument();
    expect(screen.getByText(`Trace ${traceId}`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/sources/${chunkId}`, expect.objectContaining({ credentials: "same-origin" }));
  });

  it("keeps the proposal visible and retries a temporary source failure", async () => {
    const user = userEvent.setup();
    const chunkId = "223e4567-e89b-42d3-a456-426614174000";
    const proposal = { category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9, groundedReply: { suggestedResponse: "We can review it.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Review", claim: "A review is available." }] } };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: proposal }) })
      .mockResolvedValueOnce({ json: async () => ({ ok: false, traceId, error: { code: "source_unavailable", message: "safe", retryable: true } }) })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: { chunkId, sourceId: "duplicate-charges", title: "Duplicate charges", section: "Review", content: "Exact review policy." } }) }));

    render(<TicketResolutionForm />);
    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "I was charged for both plans.");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));

    expect(await screen.findByText("We can review it.")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("exact source could not be loaded");
    await user.click(screen.getByRole("button", { name: "Retry source" }));
    expect(await screen.findByText("Exact review policy.")).toBeInTheDocument();
    expect(screen.getByText("We can review it.")).toBeInTheDocument();
  });

  it("does not render a stale source after a newer proposal replaces it", async () => {
    const user = userEvent.setup();
    const firstChunkId = "223e4567-e89b-42d3-a456-426614174000";
    const secondChunkId = "323e4567-e89b-42d3-a456-426614174000";
    let resolveFirstSource!: (value: unknown) => void;
    const firstSourceJson = new Promise((resolve) => {
      resolveFirstSource = resolve;
    });
    const proposal = (label: string, chunkId: string) => ({
      category: "billing",
      priority: "medium",
      summary: `${label} summary`,
      confidence: 0.9,
      groundedReply: {
        suggestedResponse: `${label} draft`,
        citations: [{
          chunkId,
          sourceId: `${label.toLowerCase()}-source`,
          section: `${label} section`,
          claim: `${label} claim`,
        }],
      },
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: proposal("First", firstChunkId) }) })
      .mockResolvedValueOnce({ json: () => firstSourceJson })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: proposal("Second", secondChunkId) }) })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: { chunkId: secondChunkId, sourceId: "second-source", title: "Second title", section: "Second section", content: "Second exact evidence." } }) }));

    render(<TicketResolutionForm />);
    const textarea = screen.getByRole("textbox", { name: /ticket text/i });
    await user.type(textarea, "First valid synthetic ticket");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(await screen.findByText("First draft")).toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, "Second valid synthetic ticket");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(await screen.findByText("Second exact evidence.")).toBeInTheDocument();

    resolveFirstSource({ ok: true, traceId, data: { chunkId: firstChunkId, sourceId: "first-source", title: "First title", section: "First section", content: "Stale first evidence." } });
    await vi.waitFor(() => {
      expect(screen.queryByText("Stale first evidence.")).not.toBeInTheDocument();
    });
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
