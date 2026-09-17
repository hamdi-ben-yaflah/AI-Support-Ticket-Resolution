import { describe, expect, it, vi } from "vitest";

import { ToolSourceUnavailableError } from "@/investigation/errors";
import { createEvidenceRetrieverKnowledgeSource } from "@/investigation/sources";
import { RetrievalError } from "@/retrieval/errors";
import type { EvidenceRetriever } from "@/retrieval/types";

const input = {
  query: "refund policy",
  category: "billing",
  traceId: "trace",
  signal: new AbortController().signal,
};

describe("investigation knowledge source", () => {
  it("passes successful bounded-source requests through the existing retriever boundary", async () => {
    const retriever: EvidenceRetriever = { retrieve: vi.fn().mockResolvedValue([]) };
    await expect(createEvidenceRetrieverKnowledgeSource(retriever).search(input)).resolves.toEqual(
      [],
    );
    expect(retriever.retrieve).toHaveBeenCalledWith({
      text: "refund policy",
      category: "billing",
      traceId: "trace",
      signal: input.signal,
    });
  });

  it("maps insufficient evidence to no records and preserves unavailability", async () => {
    const insufficient: EvidenceRetriever = {
      retrieve: vi
        .fn()
        .mockRejectedValue(
          new RetrievalError("insufficient_evidence", "none", { retryable: false }),
        ),
    };
    await expect(
      createEvidenceRetrieverKnowledgeSource(insufficient).search(input),
    ).resolves.toEqual([]);

    const unavailable: EvidenceRetriever = {
      retrieve: vi
        .fn()
        .mockRejectedValue(new RetrievalError("unavailable", "db detail", { retryable: true })),
    };
    await expect(
      createEvidenceRetrieverKnowledgeSource(unavailable).search(input),
    ).rejects.toBeInstanceOf(ToolSourceUnavailableError);
  });

  it("does not invoke retrieval after cancellation", async () => {
    const retriever: EvidenceRetriever = { retrieve: vi.fn() };
    const controller = new AbortController();
    controller.abort();
    await expect(
      createEvidenceRetrieverKnowledgeSource(retriever).search({
        ...input,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });
});
