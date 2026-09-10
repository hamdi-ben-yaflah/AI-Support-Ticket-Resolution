import { describe, expect, it } from "vitest";

import { createApiResultSchema } from "@/domain/api-result";
import { ClassificationSchema } from "@/domain/classification";
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
