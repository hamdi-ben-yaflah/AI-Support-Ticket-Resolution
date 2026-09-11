import { describe, expect, it } from "vitest";

import { createApiResultSchema } from "@/domain/api-result";
import { ClassificationSchema } from "@/domain/classification";
import { GroundedReplySchema, ResolutionProposalSchema } from "@/domain/grounded-reply";
import {
  PersistedResolutionRunSchema,
  ResolutionExecutionSchema,
} from "@/domain/resolution-run";
import { SourceDetailSchema } from "@/domain/source";
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

  it("accepts a bounded cited reply and both proposal branches", () => {
    expect(GroundedReplySchema.safeParse(groundedReply).success).toBe(true);
    expect(ResolutionProposalSchema.safeParse({ category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9, action: "reply", reason: "The policy supports a review.", groundedReply }).success).toBe(true);
    expect(ResolutionProposalSchema.safeParse({ category: "other", priority: "low", summary: "Unsupported question", confidence: 0.9, action: "needs_human_review", reason: "No relevant policy was retrieved." }).success).toBe(true);
  });

  it("requires citations with UUIDs and enforces response and citation limits", () => {
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: [] }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x".repeat(4_001), citations: groundedReply.citations }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: Array.from({ length: 9 }, () => groundedReply.citations[0]) }).success).toBe(false);
    expect(GroundedReplySchema.safeParse({ suggestedResponse: "x", citations: [{ ...groundedReply.citations[0], chunkId: "not-a-uuid" }] }).success).toBe(false);
  });

  it("rejects hybrid, unbounded, and unsupported proposal actions", () => {
    const base = { category: "billing", priority: "medium", summary: "Duplicate charge", confidence: 0.9 };
    expect(ResolutionProposalSchema.safeParse({ ...base, action: "needs_human_review", reason: "Review it.", groundedReply }).success).toBe(false);
    expect(ResolutionProposalSchema.safeParse({ ...base, action: "reply", reason: "Review it." }).success).toBe(false);
    expect(ResolutionProposalSchema.safeParse({ ...base, action: "escalate", reason: "Review it." }).success).toBe(false);
    expect(ResolutionProposalSchema.safeParse({ ...base, action: "needs_human_review", reason: "x".repeat(301) }).success).toBe(false);
  });

  it("keeps retrieval unavailability as an API error and rejects insufficient evidence", () => {
    const schema = createApiResultSchema(ResolutionProposalSchema);
    expect(schema.safeParse({ ok: false, traceId, error: { code: "retrieval_unavailable", message: "Safe message", retryable: true } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, traceId, error: { code: "insufficient_evidence", message: "Safe message", retryable: false } }).success).toBe(false);
  });
});

describe("source and resolution-run schemas", () => {
  const source = {
    chunkId: "223e4567-e89b-42d3-a456-426614174000",
    sourceId: "duplicate-charges",
    title: "Duplicate charges",
    section: "Review",
    content: "Exact synthetic evidence.",
  };

  it("allows only bounded display-safe source fields", () => {
    expect(SourceDetailSchema.safeParse(source).success).toBe(true);
    expect(SourceDetailSchema.safeParse({ ...source, embedding: [1] }).success).toBe(false);
    expect(SourceDetailSchema.safeParse({ ...source, content: "x".repeat(20_001) }).success).toBe(false);
  });

  it("validates a successful run without raw ticket text", () => {
    const run = {
      traceId,
      sessionHash: "a".repeat(64),
      ticketHash: "b".repeat(64),
      classification: { category: "billing", priority: "medium", summary: "Duplicate", confidence: 0.9 },
      action: { type: "reply", reason: "The policy supports a response." },
      citedSources: [{ ...source, citationPosition: 0 }],
      metadata: {
        promptVersions: { classification: "classify.v1", resolution: "resolve.v3" },
        resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
        provider: "anthropic",
        model: "test-model",
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        retryCount: 0,
        validationPassed: true,
      },
    };
    expect(PersistedResolutionRunSchema.safeParse(run).success).toBe(true);
    expect(PersistedResolutionRunSchema.safeParse({ ...run, ticketText: "raw" }).success).toBe(false);
    expect(PersistedResolutionRunSchema.safeParse({ ...run, metadata: { ...run.metadata, latencyMs: -1 } }).success).toBe(false);
  });

  it("requires cited snapshots to match public citations in the same order", () => {
    const citation = {
      chunkId: source.chunkId,
      sourceId: source.sourceId,
      section: source.section,
      claim: "The exact evidence supports this claim.",
    };
    const execution = {
      proposal: {
        category: "billing",
        priority: "medium",
        summary: "Duplicate",
        confidence: 0.9,
        action: "reply",
        reason: "The policy supports a response.",
        groundedReply: { suggestedResponse: "A draft.", citations: [citation] },
      },
      citedSources: [{ ...source, citationPosition: 0 }],
      metadata: {
        promptVersions: { classification: "classify.v1", resolution: "resolve.v3" },
        resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
        provider: "anthropic",
        model: "test-model",
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        retryCount: 0,
        validationPassed: true,
      },
    };

    expect(ResolutionExecutionSchema.safeParse(execution).success).toBe(true);
    expect(ResolutionExecutionSchema.safeParse({
      ...execution,
      citedSources: [{ ...execution.citedSources[0], chunkId: traceId }],
    }).success).toBe(false);
  });

  it("requires zero sources for human review and at least one for reply runs", () => {
    const metadata = {
      promptVersions: { classification: "classify.v1", resolution: "resolve.v3" },
      resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
      provider: "anthropic",
      model: "test-model",
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      retryCount: 0,
      validationPassed: true,
    };
    const proposal = {
      category: "other",
      priority: "low",
      summary: "Unsupported",
      confidence: 0.9,
      action: "needs_human_review",
      reason: "No relevant evidence was found.",
    };
    expect(ResolutionExecutionSchema.safeParse({ proposal, citedSources: [], metadata }).success).toBe(true);
    expect(ResolutionExecutionSchema.safeParse({ proposal, citedSources: [{ ...source, citationPosition: 0 }], metadata }).success).toBe(false);

    const persistedBase = {
      traceId,
      sessionHash: "a".repeat(64),
      ticketHash: "b".repeat(64),
      classification: { category: "other", priority: "low", summary: "Unsupported", confidence: 0.9 },
      metadata,
    };
    expect(PersistedResolutionRunSchema.safeParse({ ...persistedBase, action: { type: "needs_human_review", reason: proposal.reason }, citedSources: [] }).success).toBe(true);
    expect(PersistedResolutionRunSchema.safeParse({ ...persistedBase, action: { type: "reply", reason: "Supported." }, citedSources: [] }).success).toBe(false);
    expect(PersistedResolutionRunSchema.safeParse({ ...persistedBase, action: { type: "needs_human_review", reason: proposal.reason }, citedSources: [{ ...source, citationPosition: 0 }] }).success).toBe(false);
  });
});
