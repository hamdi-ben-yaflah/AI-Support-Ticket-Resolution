import { describe, expect, it, vi } from "vitest";

import { classifyTicketWithMetadata } from "@/ai/pipeline/classify-ticket";
import { resolveTicket } from "@/ai/pipeline/resolve-ticket";
import type { LlmProvider } from "@/ai/types";
import { createResolveHandler } from "@/app/api/tickets/resolve/route";
import type { ResolutionPolicy } from "@/config/resolution";
import type { AppLogger } from "@/observability/logger";
import { InMemoryTracing } from "@/observability/testing";
import { retrieveEvidence } from "@/retrieval/search";
import type { EvidenceRetriever } from "@/retrieval/types";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
const chunkId = "223e4567-e89b-42d3-a456-426614174000";
const ticketText = "Sensitive synthetic duplicate charge marker.";

function request() {
  return new Request("http://localhost/api/tickets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "secret-cookie" },
    body: JSON.stringify({ text: ticketText }),
  });
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
}

function provider(): LlmProvider {
  return {
    name: "anthropic",
    model: "claude-test",
    generateStructured: vi.fn(async (request: { task: string }) =>
      request.task === "classification"
        ? {
            value: {
              category: "billing",
              priority: "medium",
              summary: "Duplicate charge reported.",
              confidence: 0.94,
            },
            model: "claude-returned",
            finishReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
            latencyMs: 4,
            retryCount: 0,
            providerRequestId: "request-1",
            providerMessageId: "message-1",
          }
        : {
            value: {
              action: "reply",
              reason: "The policy supports a draft response.",
              groundedReply: {
                suggestedResponse: "We can review the duplicate charge.",
                citations: [
                  {
                    chunkId,
                    sourceId: "duplicate-charges",
                    section: "Duplicate charges > Review",
                    claim: "Settled duplicate charges can be reviewed.",
                  },
                ],
              },
            },
            model: "claude-returned",
            finishReason: "end_turn",
            usage: { inputTokens: 20, outputTokens: 8 },
            latencyMs: 6,
            retryCount: 0,
            providerRequestId: "request-2",
            providerMessageId: "message-2",
          },
    ),
  } as unknown as LlmProvider;
}

describe("ticket-resolution trace topology", () => {
  it("exports one metadata-only tree for a successful grounded resolution", async () => {
    const appTracing = new InMemoryTracing();
    const log = fakeLogger();
    const llm = provider();
    const policy: ResolutionPolicy = {
      minimumConfidence: 0.65,
      version: "resolution-policy.v1",
    };
    const retriever: EvidenceRetriever = {
      retrieve: (input) =>
        retrieveEvidence(input, {
          tracing: appTracing,
          log,
          config: {
            candidateCount: 8,
            finalCount: 5,
            minimumSimilarity: 0.65,
            maximumContextTokens: 3_500,
            minimumEvidenceCount: 1,
            version: "retrieval.v1",
          },
          embedder: {
            name: "voyage",
            model: "voyage-test",
            dimensions: 2,
            embed: vi.fn().mockResolvedValue({
              vectors: [[0.1, 0.2]],
              model: "voyage-returned",
              usage: { inputTokens: 3 },
              latencyMs: 2,
              retryCount: 0,
            }),
          },
          search: vi.fn().mockResolvedValue([
            {
              chunkId,
              title: "Duplicate charges",
              section: "Duplicate charges > Review",
              content: "Private source content marker.",
              tokenCount: 6,
              similarity: 0.912345,
              metadata: {
                sourceId: "duplicate-charges",
                category: "billing",
                version: "1",
              },
            },
          ]),
        }),
    };

    const response = await createResolveHandler({
      tracing: appTracing,
      log,
      createTraceId: () => traceId,
      createSession: () => ({ sessionHash: "a".repeat(64), ticketHash: "b".repeat(64) }),
      persist: vi.fn().mockResolvedValue(undefined),
      resolve: (input, context) =>
        resolveTicket(input, {
          ...context,
          tracing: appTracing,
          log,
          policy,
          provider: llm,
          retriever,
          classifier: (ticket, classificationContext) =>
            classifyTicketWithMetadata(ticket, {
              ...classificationContext,
              provider: llm,
              tracing: appTracing,
              log,
            }),
        }),
    })(request());

    expect(response.status).toBe(200);
    const spans = appTracing.spans;
    expect(spans.map((span) => span.name)).toEqual([
      "support.ticket.resolve",
      "support.ai.classification",
      "support.retrieval",
      "support.embedding.query",
      "support.vector_search",
      "support.ai.resolution",
      "support.grounding.validate",
      "support.resolution.persist",
    ]);

    const root = spans[0];
    const retrieval = spans.find((span) => span.name === "support.retrieval");
    expect(root?.parentId).toBeUndefined();
    expect(spans.filter((span) => span.parentId === root?.id).map((span) => span.name)).toEqual([
      "support.ai.classification",
      "support.retrieval",
      "support.ai.resolution",
      "support.grounding.validate",
      "support.resolution.persist",
    ]);
    expect(
      spans.filter((span) => span.parentId === retrieval?.id).map((span) => span.name),
    ).toEqual(["support.embedding.query", "support.vector_search"]);
    expect(root?.attributes).toMatchObject({
      "support.trace_id": traceId,
      "support.action": "reply",
      "support.citation_count": 1,
    });
    expect(spans.every((span) => span.ended)).toBe(true);

    const exported = JSON.stringify(spans);
    const logs = JSON.stringify([
      vi.mocked(log.info).mock.calls,
      vi.mocked(log.warn).mock.calls,
      vi.mocked(log.error).mock.calls,
    ]);
    for (const canary of [
      ticketText,
      "Private source content marker.",
      "secret-cookie",
      "We can review the duplicate charge.",
    ]) {
      expect(logs).not.toContain(canary);
    }
    expect(exported).not.toContain(ticketText);
    expect(exported).not.toContain("Duplicate charge reported.");
    expect(exported).not.toContain("We can review the duplicate charge.");
    expect(exported).not.toContain("Private source content marker.");
    expect(exported).not.toContain("secret-cookie");
    expect(exported).not.toContain("a".repeat(64));
    expect(exported).not.toContain("b".repeat(64));
  });
});
