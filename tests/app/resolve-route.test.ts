import { describe, expect, it, vi } from "vitest";

import { LlmError, type LlmErrorCode } from "@/ai/errors";
import { createResolveHandler } from "@/app/api/tickets/resolve/route";
import { SessionConfigurationError } from "@/config/session";
import type { ResolutionProposal } from "@/domain/grounded-reply";
import type { ResolutionExecution } from "@/domain/resolution-run";
import type { AppLogger } from "@/observability/logger";
import { RetrievalError } from "@/retrieval/errors";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
const chunkId = "223e4567-e89b-42d3-a456-426614174000";
const proposal: ResolutionProposal = {
  category: "billing", priority: "medium", summary: "Customer reports a duplicate plan charge.", confidence: 0.9,
  groundedReply: { suggestedResponse: "I’m sorry about the duplicate charge. We can submit it for review.", citations: [{ chunkId, sourceId: "duplicate-charges", section: "Duplicate charges > When both charges settled", claim: "Duplicate settled charges can be submitted for review." }] },
};
const execution: ResolutionExecution = {
  proposal,
  citedSources: [{
    citationPosition: 0,
    chunkId,
    sourceId: "duplicate-charges",
    title: "Duplicate charges",
    section: "Duplicate charges > When both charges settled",
    content: "Settled duplicate charges can be submitted for review.",
  }],
  metadata: {
    promptVersions: { classification: "classify.v1", resolution: "resolve.v1" },
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

function logger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger; }
function request(body: string) { return new Request("http://localhost/api/tickets/resolve", { method: "POST", headers: { "content-type": "application/json" }, body }); }

describe("POST /api/tickets/resolve", () => {
  it("returns a grounded result with the route trace ID", async () => {
    const resolve = vi.fn().mockResolvedValue(execution);
    const persist = vi.fn().mockResolvedValue(undefined);
    const response = await createResolveHandler({ resolve, persist, createSession: () => session, createTraceId: () => traceId, log: logger() })(request(JSON.stringify({ text: "I was charged for both plans.", customerTier: "premium" })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, traceId, data: { category: "billing", groundedReply: { citations: [{ chunkId }] } } });
    expect(resolve).toHaveBeenCalledWith({ text: "I was charged for both plans.", customerTier: "premium" }, { traceId });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      traceId,
      sessionHash: session.sessionHash,
      ticketHash: session.ticketHash,
      citedSources: execution.citedSources,
    }));
    expect(response.headers.get("set-cookie")).toContain("support_copilot_session=signed-cookie");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(JSON.stringify(body)).not.toContain(execution.citedSources[0]?.content);
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
    const response = await createResolveHandler({ resolve, createTraceId: () => traceId, log: logger() })(request("{"));
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([{ text: "" }, { text: "123456789" }, { text: "x".repeat(10_001) }, { text: "A valid ticket body", customerTier: "vip" }])("rejects invalid input without a provider call", async (body) => {
    const resolve = vi.fn();
    const response = await createResolveHandler({ resolve, createTraceId: () => traceId, log: logger() })(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each<[LlmErrorCode, number, string, boolean]>([["timeout", 504, "provider_timeout", true], ["unavailable", 503, "provider_unavailable", true], ["refused", 502, "model_refused", false], ["truncated", 502, "model_truncated", false], ["invalid_output", 502, "model_output_invalid", false], ["configuration", 500, "configuration_error", false], ["unexpected", 500, "internal_error", false]])("maps %s failures to a safe response", async (code, status, apiCode, retryable) => {
    const resolve = vi.fn().mockRejectedValue(new LlmError(code, "sensitive SDK detail and ticket content", { retryable }));
    const response = await createResolveHandler({ resolve, createSession: () => session, createTraceId: () => traceId, log: logger() })(request(JSON.stringify({ text: "A valid ticket body" })));
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body).toMatchObject({ ok: false, traceId, error: { code: apiCode, retryable } });
    expect(JSON.stringify(body)).not.toContain("sensitive SDK detail");
  });

  it.each([["unavailable", 503, "retrieval_unavailable", true], ["insufficient_evidence", 422, "insufficient_evidence", false]] as const)("maps retrieval %s safely", async (code, status, apiCode, retryable) => {
    const resolve = vi.fn().mockRejectedValue(new RetrievalError(code, "sensitive database detail", { retryable }));
    const response = await createResolveHandler({ resolve, createSession: () => session, createTraceId: () => traceId, log: logger() })(request(JSON.stringify({ text: "A valid ticket body" })));
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body).toMatchObject({ ok: false, traceId, error: { code: apiCode, retryable } });
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
  });
});
