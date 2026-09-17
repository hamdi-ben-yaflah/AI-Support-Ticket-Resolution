import { describe, expect, it } from "vitest";

import { InMemoryTracing } from "@/observability/testing";
import { withTraceCorrelation } from "@/observability/tracing";

describe("typed tracing facade", () => {
  it("retains parentage, safe retry metadata, and active log correlation", async () => {
    const tracing = new InMemoryTracing();
    let correlation: ReturnType<typeof withTraceCorrelation> | undefined;

    await tracing.withSpan(
      "support.ticket.resolve",
      { root: true, attributes: { "support.trace_id": "application-trace" } },
      async () => {
        correlation = withTraceCorrelation({ event: "inside" }, tracing);
        await tracing.withSpan("support.ai.classification", {}, async (span) => {
          span.addRetryEvent({
            attempt: 1,
            retryCount: 1,
            delayMs: 187.5,
            errorCode: "unavailable",
          });
          span.setAttributes({ "support.outcome": "completed" });
        });
      },
    );

    expect(tracing.spans).toMatchObject([
      {
        id: "1",
        name: "support.ticket.resolve",
        ended: true,
        attributes: { "langfuse.observation.type": "CHAIN" },
      },
      {
        id: "2",
        parentId: "1",
        name: "support.ai.classification",
        ended: true,
        attributes: { "langfuse.observation.type": "GENERATION" },
        events: [
          {
            name: "support.retry",
            attributes: { errorCode: "unavailable", retryCount: 1 },
          },
        ],
      },
    ]);
    expect(correlation).toEqual({
      event: "inside",
      otelTraceId: "trace-1",
      otelSpanId: "span-1",
    });
  });

  it("does not retain arbitrary thrown error messages", async () => {
    const tracing = new InMemoryTracing();
    await expect(
      tracing.withSpan("support.ai.resolution", {}, async (span) => {
        span.fail("unexpected");
        throw new Error("raw provider body and secret ticket text");
      }),
    ).rejects.toThrow("raw provider body");

    expect(JSON.stringify(tracing.spans)).not.toContain("raw provider body");
    expect(tracing.spans[0]).toMatchObject({ errorCode: "unexpected", ended: true });
  });
});
