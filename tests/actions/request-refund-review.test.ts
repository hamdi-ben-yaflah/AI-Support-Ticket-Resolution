import { describe, expect, it } from "vitest";

import { executeMockRefundReview } from "@/actions/request-refund-review";

describe("requestRefundReview mock", () => {
  it("creates a deterministic local-only result from validated arguments", () => {
    const proposalId = "323e4567-e89b-42d3-a456-426614174000";
    const result = executeMockRefundReview(
      {
        reason: "The settled duplicate-charge policy supports a review.",
        ticketSummary: "Two settled duplicate charges were reported.",
        evidenceChunkIds: ["223e4567-e89b-42d3-a456-426614174000"],
      },
      {
        proposalId,
        executedAt: new Date("2026-09-12T10:00:00.000Z"),
      },
    );

    expect(result).toEqual({
      proposalId,
      status: "mock_review_recorded",
      message: expect.stringContaining("No refund was approved or issued"),
      executedAt: "2026-09-12T10:00:00.000Z",
    });
  });

  it("rejects invalid arguments before producing a result", () => {
    expect(() =>
      executeMockRefundReview(
        {
          reason: "short",
          ticketSummary: "Summary",
          evidenceChunkIds: ["223e4567-e89b-42d3-a456-426614174000"],
        },
        {
          proposalId: "323e4567-e89b-42d3-a456-426614174000",
          executedAt: new Date("2026-09-12T10:00:00.000Z"),
        },
      ),
    ).toThrow();
  });
});
