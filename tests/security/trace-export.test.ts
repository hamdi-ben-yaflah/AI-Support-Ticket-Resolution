import { afterAll, describe, expect, it } from "vitest";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { tracing, type SafeTraceAttributes } from "@/observability/tracing";

const exported: unknown[] = [];
const sdk = new NodeSDK({
  spanProcessors: [
    {
      onStart() {},
      onEnd(span) {
        exported.push(span.attributes);
        for (const event of span.events) exported.push(event.attributes);
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    },
  ],
});
sdk.start();
afterAll(() => sdk.shutdown());

describe("runtime trace export boundary", () => {
  it("drops unknown content attributes at creation and update, including thrown error bodies", async () => {
    const canary = "SYNTHETIC-SECRET-CANARY";
    const attributes = {
      "support.task": "resolve",
      "gen_ai.prompt": canary,
      ticketText: canary,
      providerResponse: canary,
    } as SafeTraceAttributes;
    await expect(
      tracing.withSpan("support.ticket.resolve", { root: true, attributes }, async (span) => {
        span.setAttributes({
          "support.outcome": "failed",
          "gen_ai.response": canary,
        } as SafeTraceAttributes);
        span.setAttributes({
          "support.duration_ms": Number.NaN,
          "support.retrieval.similarities": Array.from({ length: 101 }, () => 1),
          "support.operation": "x".repeat(201),
        });
        span.fail("invalid_output");
        throw new Error(canary);
      }),
    ).rejects.toThrow(canary);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      "support.task": "resolve",
      "support.outcome": "failed",
      "error.type": "invalid_output",
    });
    expect(JSON.stringify(exported)).not.toContain(canary);
    expect(exported[0]).not.toHaveProperty("support.duration_ms");
    expect(exported[0]).not.toHaveProperty("support.retrieval.similarities");
    expect(exported[0]).not.toHaveProperty("support.operation");
  });

  it("filters retry event attributes through the same allowlist as span attributes", async () => {
    await tracing.withSpan("support.ai.resolution", { root: true }, async (span) => {
      span.addRetryEvent({
        attempt: 2,
        retryCount: 1,
        delayMs: 187.5,
        errorCode: "unavailable",
      });
    });
    const event = exported.at(-1) as Record<string, unknown>;
    expect(event).toEqual({
      "support.attempt": 2,
      "support.retry_count": 1,
      "support.retry_delay_ms": 188,
      "error.type": "unavailable",
    });
  });
});
