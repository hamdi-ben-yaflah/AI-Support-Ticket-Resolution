import { describe, expect, it } from "vitest";

import { createApiResultSchema } from "@/domain/api-result";
import { ClassificationSchema } from "@/domain/classification";
import { GroundedReplySchema, ResolutionProposalSchema } from "@/domain/grounded-reply";
import { TicketInputSchema } from "@/domain/ticket";

const traceId = "123e4567-e89b-42d3-a456-426614174000";

describe("TicketInputSchema", () => {
  it("trims valid input and accepts both documented tiers", () => {
    expect(
      TicketInputSchema.parse({ text: "  Charged twice  ", customerTier: "premium" }),
    ).toEqual({ text: "Charged twice", customerTier: "premium" });
    expect(TicketInputSchema.safeParse({ text: "Password reset", customerTier: "standard" }).success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "            "],
    ["nine characters", "123456789"],
    ["over 10,000 characters", "a".repeat(10_001)],
  ])("rejects %s text", (_case, text) => {
    expect(TicketInputSchema.safeParse({ text }).success).toBe(false);
  });

  it("accepts exact text boundaries and rejects unsupported tiers", () => {
    expect(TicketInputSchema.safeParse({ text: "a".repeat(10) }).success).toBe(true);
    expect(TicketInputSchema.safeParse({ text: "a".repeat(10_000) }).success).toBe(true);
    expect(TicketInputSchema.safeParse({ text: "A valid support ticket", customerTier: "vip" }).success).toBe(false);
  });
});

describe("ClassificationSchema", () => {
  it("accepts documented values at confidence and summary boundaries", () => {
    expect(
      ClassificationSchema.safeParse({ category: "billing", priority: "high", summary: "x", confidence: 0 }).success,
    ).toBe(true);
    expect(
      ClassificationSchema.safeParse({
        category: "other",
        priority: "low",
        summary: "x".repeat(300),
        confidence: 1,
      }).success,
    ).toBe(true);
  });

  it.each([
    { category: "sales", priority: "low", summary: "Question", confidence: 0.5 },
    { category: "account", priority: "urgent", summary: "Locked out", confidence: 0.5 },
    { category: "account", priority: "high", summary: "", confidence: 0.5 },
    { category: "account", priority: "high", summary: "x".repeat(301), confidence: 0.5 },
    { category: "account", priority: "high", summary: "Locked out", confidence: 1.1 },
  ])("rejects an invalid classification", (classification) => {
    expect(ClassificationSchema.safeParse(classification).success).toBe(false);
  });
});

describe("API result schema", () => {
  const schema = createApiResultSchema(ClassificationSchema);

  it("validates success and controlled error envelopes", () => {
    expect(
      schema.safeParse({
        ok: true,
        traceId,
        data: { category: "technical", priority: "medium", summary: "App crashes", confidence: 0.8 },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        traceId,
        error: { code: "provider_timeout", message: "Timed out", retryable: true },
      }).success,
    ).toBe(true);
  });

  it("rejects a non-UUID trace and unknown error code", () => {
    expect(schema.safeParse({ ok: false, traceId: "trace", error: { code: "secret", message: "x", retryable: false } }).success).toBe(false);
  });
});

describe("grounded reply schemas", () => {
  const groundedReply = {
    suggestedResponse: "We can review the duplicate charge.",
    citations: [{
      chunkId: "223e4567-e89b-42d3-a456-426614174000",
      sourceId: "duplicate-charges",
      section: "Duplicate charges > Review",
      claim: "Settled duplicates are eligible for review.",
    }],
  };

  it("accepts a bounded cited reply and composed proposal", () => {
    expect(GroundedReplySchema.safeParse(groundedReply).success).toBe(true);
    expect(ResolutionProposalSchema.safeParse({ category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9, groundedReply }).success).toBe(true);
  });

  it("requires citations with UUIDs and enforces response and citation limits", () => {
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: [] }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x".repeat(4_001), citations: groundedReply.citations }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: Array.from({ length: 9 }, () => groundedReply.citations[0]) }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: [{ ...groundedReply.citations[0], chunkId: "not-a-uuid" }] }).success).toBe(false);
  });

  it.each(["retrieval_unavailable", "insufficient_evidence"])("allows the %s API error code", (code) => {
    const schema = createApiResultSchema(ResolutionProposalSchema);
    expect(schema.safeParse({ ok: false, traceId, error: { code, message: "Safe message", retryable: false } }).success).toBe(true);
  });
});
