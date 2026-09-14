import { describe, expect, it, vi } from "vitest";

import { LlmError, type LlmErrorCode } from "@/ai/errors";
import { createResolveHandler } from "@/app/api/tickets/resolve/route";
import { SessionConfigurationError } from "@/config/session";
import type { RefundReviewResolutionProposal, ResolutionProposal } from "@/domain/grounded-reply";
import type { ResolutionExecution } from "@/domain/resolution-run";
import type { AppLogger } from "@/observability/logger";
import { RetrievalError } from "@/retrieval/errors";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
const chunkId = "223e4567-e89b-42d3-a456-426614174000";
const proposal: ResolutionProposal = {
  category: "billing",
  priority: "medium",
  summary: "Customer reports a duplicate plan charge.",
  confidence: 0.9,
  action: "reply",
  reason: "The retrieved duplicate-charge policy supports a draft.",
  groundedReply: {
    suggestedResponse: "I’m sorry about the duplicate charge. We can submit it for review.",
    citations: [
      {
        chunkId,
        sourceId: "duplicate-charges",
        section: "Duplicate charges > When both charges settled",
        claim: "Duplicate settled charges can be submitted for review.",
      },
    ],
  },
};
const execution: ResolutionExecution = {
  proposal,
  citedSources: [
    {
      citationPosition: 0,
      chunkId,
      sourceId: "duplicate-charges",
      title: "Duplicate charges",
      section: "Duplicate charges > When both charges settled",
      content: "Settled duplicate charges can be submitted for review.",
    },
  ],
  metadata: {
    promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
    resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
    provider: "fake",
    model: "fake-model",
    latencyMs: 10,
    inputTokens: 20,
    outputTokens: 10,
    retryCount: 0,
    validationPassed: true,
  },
};
const session = {
  sessionHash: "a".repeat(64),
  ticketHash: "b".repeat(64),
  cookie: {
    name: "support_copilot_session",
    value: "signed-cookie",
    options: {
      httpOnly: true as const,
      sameSite: "lax" as const,
      path: "/" as const,
      maxAge: 60,
      secure: false,
    },
  },
};

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
}
function request(body: string) {
  return new Request("http://localhost/api/tickets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/tickets/resolve", () => {
  it("returns a grounded result with the route trace ID", async () => {
    const resolve = vi.fn().mockResolvedValue(execution);
    const persist = vi.fn().mockResolvedValue(undefined);
    const response = await createResolveHandler({
      resolve,
      persist,
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "I was charged for both plans.", customerTier: "premium" })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      traceId,
      data: { category: "billing", action: "reply", groundedReply: { citations: [{ chunkId }] } },
    });
    expect(resolve).toHaveBeenCalledWith(
      { text: "I was charged for both plans.", customerTier: "premium" },
      { traceId },
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId,
        sessionHash: session.sessionHash,
        ticketHash: session.ticketHash,
        citedSources: execution.citedSources,
        action: { type: "reply", reason: proposal.reason },
      }),
    );
    expect(response.headers.get("set-cookie")).toContain("support_copilot_session=signed-cookie");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(JSON.stringify(body)).not.toContain(execution.citedSources[0]?.content);
  });

  it("persists a pending refund proposal before returning it", async () => {
    const refundProposal: RefundReviewResolutionProposal = {
      category: "billing" as const,
      priority: proposal.priority,
      summary: proposal.summary,
      confidence: proposal.confidence,
      action: "request_refund_review",
      reason: "The settled duplicate-charge policy supports a refund review.",
      groundedReply: proposal.groundedReply,
      actionProposal: {
        proposalId: "323e4567-e89b-42d3-a456-426614174000",
        toolName: "requestRefundReview",
        state: "pending_confirmation",
        arguments: {
          reason: "The settled duplicate-charge policy supports a refund review.",
          ticketSummary: proposal.summary,
          evidenceChunkIds: [chunkId],
        },
      },
    };
    const refundExecution: ResolutionExecution = {
      ...execution,
      proposal: refundProposal,
    };
    const persist = vi.fn().mockResolvedValue(undefined);
    const response = await createResolveHandler({
      resolve: vi.fn().mockResolvedValue(refundExecution),
      persist,
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "Both invoice charges settled." })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        action: "request_refund_review",
        actionProposal: { state: "pending_confirmation" },
      },
    });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        action: {
          type: "request_refund_review",
          reason: refundProposal.reason,
          proposal: refundProposal.actionProposal,
        },
        citedSources: refundExecution.citedSources,
      }),
    );
  });

  it("does not return a proposal when its source authorization context cannot be saved", async () => {
    const response = await createResolveHandler({
      resolve: vi.fn().mockResolvedValue(execution),
      persist: vi.fn().mockRejectedValue(new Error("database detail")),
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "I was charged for both plans." })));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error", retryable: true },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reuses an existing valid session without replacing its cookie", async () => {
    const response = await createResolveHandler({
      resolve: vi.fn().mockResolvedValue(execution),
      persist: vi.fn().mockResolvedValue(undefined),
      createSession: () => ({
        sessionHash: session.sessionHash,
        ticketHash: session.ticketHash,
      }),
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "I was charged for both plans." })));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns and persists a successful abstention without source grants", async () => {
    const abstention: ResolutionExecution = {
      proposal: {
        category: "other",
        priority: "low",
        summary: "Question is outside the available support policy.",
        confidence: 0.92,
        action: "needs_human_review",
        reason: "The knowledge base does not contain enough evidence for a safe reply.",
      },
      citedSources: [],
      metadata: execution.metadata,
    };
    const persist = vi.fn().mockResolvedValue(undefined);
    const response = await createResolveHandler({
      resolve: vi.fn().mockResolvedValue(abstention),
      persist,
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "What is the weather next weekend?" })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      traceId,
      data: { action: "needs_human_review", reason: expect.stringContaining("evidence") },
    });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        action: {
          type: "needs_human_review",
          reason: abstention.proposal.reason,
        },
        citedSources: [],
      }),
    );
  });

  it("maps invalid session configuration without calling the resolver", async () => {
    const resolve = vi.fn();
    const response = await createResolveHandler({
      resolve,
      createSession: () => {
        throw new SessionConfigurationError();
      },
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "I was charged for both plans." })));

    expect(response.status).toBe(500);
    expect(resolve).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "configuration_error", retryable: false },
    });
  });

  it("rejects malformed JSON without calling the resolver", async () => {
    const resolve = vi.fn();
    const response = await createResolveHandler({
      resolve,
      createTraceId: () => traceId,
      log: logger(),
    })(request("{"));
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    { text: "" },
    { text: "123456789" },
    { text: "x".repeat(10_001) },
    { text: "A valid ticket body", customerTier: "vip" },
  ])("rejects invalid input without a provider call", async (body) => {
    const resolve = vi.fn();
    const response = await createResolveHandler({
      resolve,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each<[LlmErrorCode, number, string, boolean]>([
    ["timeout", 504, "provider_timeout", true],
    ["unavailable", 503, "provider_unavailable", true],
    ["refused", 502, "model_refused", false],
    ["truncated", 502, "model_truncated", false],
    ["invalid_output", 502, "model_output_invalid", false],
    ["configuration", 500, "configuration_error", false],
    ["unexpected", 500, "internal_error", false],
  ])("maps %s failures to a safe response", async (code, status, apiCode, retryable) => {
    const resolve = vi
      .fn()
      .mockRejectedValue(
        new LlmError(code, "sensitive SDK detail and ticket content", { retryable }),
      );
    const response = await createResolveHandler({
      resolve,
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "A valid ticket body" })));
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body).toMatchObject({ ok: false, traceId, error: { code: apiCode, retryable } });
    expect(JSON.stringify(body)).not.toContain("sensitive SDK detail");
  });

  it.each([["unavailable", 503, "retrieval_unavailable", true]] as const)(
    "maps retrieval %s safely",
    async (code, status, apiCode, retryable) => {
      const resolve = vi
        .fn()
        .mockRejectedValue(new RetrievalError(code, "sensitive database detail", { retryable }));
      const response = await createResolveHandler({
        resolve,
        createSession: () => session,
        createTraceId: () => traceId,
        log: logger(),
      })(request(JSON.stringify({ text: "A valid ticket body" })));
      const body = await response.json();
      expect(response.status).toBe(status);
      expect(body).toMatchObject({ ok: false, traceId, error: { code: apiCode, retryable } });
      expect(JSON.stringify(body)).not.toContain("sensitive database detail");
    },
  );

  it("does not expose a leaked internal insufficient-evidence error as a normal abstention", async () => {
    const resolve = vi.fn().mockRejectedValue(
      new RetrievalError("insufficient_evidence", "sensitive retrieval detail", {
        retryable: false,
      }),
    );
    const response = await createResolveHandler({
      resolve,
      createSession: () => session,
      createTraceId: () => traceId,
      log: logger(),
    })(request(JSON.stringify({ text: "A valid ticket body" })));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error", retryable: false },
    });
  });
});
