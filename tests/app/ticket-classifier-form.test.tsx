// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TicketClassifierForm } from "@/app/ticket-classifier-form";

const traceId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => vi.unstubAllGlobals());

describe("TicketClassifierForm", () => {
  it("prevents empty and short input and explains the boundary", async () => {
    const user = userEvent.setup();
    render(<TicketClassifierForm />);
    const button = screen.getByRole("button", { name: "Classify ticket" });
    const textarea = screen.getByRole("textbox", { name: /ticket text/i });

    expect(button).toBeDisabled();
    await user.type(textarea, "too short");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("at least 10 characters");
    expect(button).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "x".repeat(10_001) } });
    expect(screen.getByRole("alert")).toHaveTextContent("at or below 10,000");
    expect(button).toBeDisabled();
  });

  it("submits an optional tier once, shows loading, and renders a validated result", async () => {
    const user = userEvent.setup();
    let resolveJson!: (value: unknown) => void;
    const json = new Promise((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({ json: () => json });
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketClassifierForm />);

    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "I was charged for both plans.");
    await user.selectOptions(screen.getByRole("combobox", { name: /customer tier/i }), "premium");
    await user.click(screen.getByRole("button", { name: "Classify ticket" }));

    expect(screen.getByRole("button", { name: /classifying/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Reviewing the ticket");
    fireEvent.submit(screen.getByRole("button", { name: /classifying/i }).closest("form")!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      text: "I was charged for both plans.",
      customerTier: "premium",
    });

    resolveJson({
      ok: true,
      traceId,
      data: {
        category: "billing",
        priority: "medium",
        summary: "Customer reports charges for both plans.",
        confidence: 0.89,
      },
    });

    expect(await screen.findByText("Customer reports charges for both plans.")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText(`Trace ${traceId}`)).toBeInTheDocument();
    expect(screen.getByText("Human review required")).toBeInTheDocument();
  });

  it("renders controlled timeout details and the server trace ID", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          ok: false,
          traceId,
          error: { code: "provider_timeout", message: "unsafe upstream detail", retryable: true },
        }),
      }),
    );
    render(<TicketClassifierForm />);

    await user.type(screen.getByRole("textbox", { name: /ticket text/i }), "The product will not start.");
    await user.click(screen.getByRole("button", { name: "Classify ticket" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("took too long");
    expect(alert).toHaveTextContent(traceId);
    expect(alert).not.toHaveTextContent("unsafe upstream detail");
    expect(screen.getByRole("button", { name: "Try classification again" })).toBeEnabled();
  });
});
