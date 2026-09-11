import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "@/embeddings/types";
import { ingestKnowledgeBase, type IngestionRepository } from "@/ingestion/ingest";
import { parseKnowledgeDocument } from "@/ingestion/chunk-markdown";

function parsed(sourceId: string, content = "Procedure") {
  return parseKnowledgeDocument(`${sourceId}.md`, `---\nsourceId: ${sourceId}\ntitle: Test\ncategory: account\nversion: "1.0"\n---\n# Test\n\n${content}`);
}

function dependencies(existing = new Map<string, string>()) {
  const embed = vi.fn().mockImplementation(async (texts: readonly string[]) => ({
    vectors: texts.map((_, index) => [index, 1]),
    model: "fake",
    usage: { inputTokens: texts.length },
    latencyMs: 1,
    retryCount: 0,
  }));
  const embedder = { name: "fake", model: "fake", dimensions: 2, embed } satisfies EmbeddingProvider;
  const repository = {
    getContentHashes: vi.fn().mockResolvedValue(existing),
    replaceDocument: vi.fn().mockResolvedValue(undefined),
  } satisfies IngestionRepository;
  return { embedder, repository, embed };
}

describe("ingestKnowledgeBase", () => {
  it("skips unchanged documents without embedding or persistence", async () => {
    const doc = parsed("unchanged");
    const deps = dependencies(new Map([[doc.sourceId, doc.contentHash]]));
    const summary = await ingestKnowledgeBase({ documents: [doc], ...deps, batchSize: 2, traceId: "trace" });
    expect(summary).toMatchObject({ skipped: 1, updated: 0, chunks: 0 });
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.repository.replaceDocument).not.toHaveBeenCalled();
  });

  it("batches embeddings and persists a changed document only after validation", async () => {
    const doc = parsed("changed", "Safe procedure. ".repeat(400));
    const deps = dependencies();
    const summary = await ingestKnowledgeBase({ documents: [doc], ...deps, batchSize: 2, traceId: "trace" });
    expect(summary.updated).toBe(1);
    expect(deps.embed.mock.calls.length).toBe(Math.ceil(doc.chunks.length / 2));
    expect(deps.repository.replaceDocument).toHaveBeenCalledOnce();
  });

  it("does not persist after an embedding failure", async () => {
    const doc = parsed("failed");
    const deps = dependencies();
    deps.embed.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(ingestKnowledgeBase({ documents: [doc], ...deps, batchSize: 2, traceId: "trace" })).rejects.toThrow();
    expect(deps.repository.replaceDocument).not.toHaveBeenCalled();
  });

  it("rejects duplicate source IDs before repository access", async () => {
    const deps = dependencies();
    await expect(ingestKnowledgeBase({ documents: [parsed("same"), parsed("same", "Other")], ...deps, batchSize: 2, traceId: "trace" })).rejects.toThrow("Duplicate");
    expect(deps.repository.getContentHashes).not.toHaveBeenCalled();
  });
});
