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
    resolveJson({ ok: true, traceId, data: { category: "billing", priority: "medium", summary: "Customer reports charges for both plans.", confidence: 0.89, action: "reply", reason: "The retrieved policy supports a duplicate-charge review.", groundedReply: { suggestedResponse: "I’m sorry about the duplicate charge. We can submit this for review.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Duplicate charges > When both charges settled", claim: "Duplicate settled charges can be reviewed." }] } } });
    expect(await screen.findByText(/submit this for review/)).toBeInTheDocument();
    expect(screen.getByText("Draft · not sent")).toBeInTheDocument();
    expect(screen.getByText("Supported draft ready")).toBeInTheDocument();
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
    const proposal = { category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9, action: "reply", reason: "The retrieved policy supports a review.", groundedReply: { suggestedResponse: "We can review it.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Review", claim: "A review is available." }] } };
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
      action: "reply",
      reason: `${label} evidence supports a reply`,
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

  it("renders an evidence warning without loading sources or showing a draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        traceId,
        data: {
          category: "other",
          priority: "low",
          summary: "The request is outside the available support guidance.",
          confidence: 0.91,
          action: "needs_human_review",
          reason: "The knowledge base does not contain enough evidence for a safe reply.",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketResolutionForm />);
    await user.type(
      screen.getByRole("textbox", { name: /ticket text/i }),
      "What is the weather next weekend?",
    );
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Insufficient evidence warning");
    expect(alert).toHaveTextContent("Human review required");
    expect(alert).toHaveTextContent("91% confidence signal");
    expect(alert).toHaveTextContent("does not contain enough evidence");
    expect(alert).toHaveTextContent("No proposed reply or customer action was produced");
    expect(alert).toHaveTextContent(`Trace ${traceId}`);
    expect(screen.queryByText("Draft · not sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge citations")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears a pending source when an abstention replaces a cited reply", async () => {
    const user = userEvent.setup();
    const chunkId = "223e4567-e89b-42d3-a456-426614174000";
    let resolveSource!: (value: unknown) => void;
    const sourceJson = new Promise((resolve) => {
      resolveSource = resolve;
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: { category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9, action: "reply", reason: "Supported.", groundedReply: { suggestedResponse: "We can review it.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Review", claim: "Review is supported." }] } } }) })
      .mockResolvedValueOnce({ json: () => sourceJson })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, traceId, data: { category: "other", priority: "low", summary: "Unsupported question", confidence: 0.9, action: "needs_human_review", reason: "No relevant evidence was found." } }) }));

    render(<TicketResolutionForm />);
    const textarea = screen.getByRole("textbox", { name: /ticket text/i });
    await user.type(textarea, "I was charged for both plans.");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(await screen.findByText("We can review it.")).toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, "What is the weather next weekend?");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    expect(await screen.findByText("No relevant evidence was found.")).toBeInTheDocument();

    resolveSource({ ok: true, traceId, data: { chunkId, sourceId: "duplicate-charges", title: "Stale source", section: "Review", content: "Stale exact evidence." } });
    await vi.waitFor(() => {
      expect(screen.queryByText("Stale exact evidence.")).not.toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([["retrieval_unavailable", "temporarily unavailable", "Try resolution again"], ["model_output_invalid", "did not pass validation", undefined]] as const)("renders controlled %s details", async (code, message, retryLabel) => {
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

  it("shows pending mock arguments and confirms exactly once on a double click", async () => {
    const user = userEvent.setup();
    const chunkId = "223e4567-e89b-42d3-a456-426614174000";
    const proposalId = "323e4567-e89b-42d3-a456-426614174000";
    const reason = "The settled duplicate-charge policy supports a refund review.";
    let resolveConfirmation!: (value: unknown) => void;
    const confirmationJson = new Promise((resolve) => {
      resolveConfirmation = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          traceId,
          data: {
            category: "billing",
            priority: "medium",
            summary: "Two settled duplicate invoices were reported.",
            confidence: 0.94,
            action: "request_refund_review",
            reason,
            groundedReply: {
              suggestedResponse: "I can submit these duplicate charges for review.",
              citations: [{
                chunkId,
                sourceId: "duplicate-charges",
                section: "When both charges settled",
                claim: "Settled duplicates may be reviewed.",
              }],
            },
            actionProposal: {
              proposalId,
              toolName: "requestRefundReview",
              state: "pending_confirmation",
              arguments: {
                reason,
                ticketSummary: "Two settled duplicate invoices were reported.",
                evidenceChunkIds: [chunkId],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          traceId,
          data: {
            chunkId,
            sourceId: "duplicate-charges",
            title: "Duplicate charges",
            section: "When both charges settled",
            content: "Both settled duplicates may be submitted for review.",
          },
        }),
      })
      .mockResolvedValueOnce({ json: () => confirmationJson });
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketResolutionForm />);
    await user.type(
      screen.getByRole("textbox", { name: /ticket text/i }),
      "Invoices INV-1 and INV-2 are settled duplicates.",
    );
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));

    expect(await screen.findByText("Mock review proposal ready")).toBeInTheDocument();
    expect(screen.getByText("requestRefundReview")).toBeInTheDocument();
    expect(screen.getByText("pending_confirmation")).toBeInTheDocument();
    expect(screen.getAllByText(reason)).toHaveLength(2);
    expect(screen.getAllByText(chunkId).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const confirm = screen.getByRole("button", { name: "Confirm mock review" });
    await user.dblClick(confirm);
    expect(screen.getByRole("button", { name: /recording mock review/i })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/actions/refund-review/${proposalId}/confirm`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: '{"confirmed":true}',
      }),
    );

    resolveConfirmation({
      ok: true,
      traceId,
      data: {
        proposalId,
        status: "mock_review_recorded",
        message: "A local mock record was created. No refund was approved or issued.",
        executedAt: "2026-09-12T10:00:00.000Z",
      },
    });
    expect(await screen.findByText("Local mock review recorded")).toBeInTheDocument();
    expect(screen.getByText(/No refund was approved or issued/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm again/ })).toBeEnabled();
  });

  it("rejects a refund proposal locally without sending a confirmation request", async () => {
    const user = userEvent.setup();
    const chunkId = "223e4567-e89b-42d3-a456-426614174000";
    const reason = "The settled duplicate-charge policy supports a refund review.";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          traceId,
          data: {
            category: "billing",
            priority: "medium",
            summary: "Two settled duplicate invoices were reported.",
            confidence: 0.94,
            action: "request_refund_review",
            reason,
            groundedReply: {
              suggestedResponse: "I can submit these charges for review.",
              citations: [{
                chunkId,
                sourceId: "duplicate-charges",
                section: "When both charges settled",
                claim: "Settled duplicates may be reviewed.",
              }],
            },
            actionProposal: {
              proposalId: "323e4567-e89b-42d3-a456-426614174000",
              toolName: "requestRefundReview",
              state: "pending_confirmation",
              arguments: {
                reason,
                ticketSummary: "Two settled duplicate invoices were reported.",
                evidenceChunkIds: [chunkId],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          traceId,
          data: {
            chunkId,
            sourceId: "duplicate-charges",
            title: "Duplicate charges",
            section: "When both charges settled",
            content: "Settled duplicates may be reviewed.",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketResolutionForm />);
    await user.type(
      screen.getByRole("textbox", { name: /ticket text/i }),
      "Invoices INV-1 and INV-2 are settled duplicates.",
    );
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    await user.click(await screen.findByRole("button", { name: "Reject proposal" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "No confirmation request was sent",
    );
    expect(screen.queryByRole("button", { name: "Confirm mock review" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
