import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sourceId = "integration-resolution-source";
const traceIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const ownerHash = "a".repeat(64);
const otherHash = "b".repeat(64);

function isolatedTestUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (!databaseName.endsWith("_test") || databaseName.length <= 5) {
    throw new Error("Integration tests require a database name ending in _test.");
  }
  return value;
}

function vector(): number[] {
  const value = Array.from({ length: 1_024 }, () => 0);
  value[0] = 1;
  return value;
}

function runInput(traceId: string, chunkId: string) {
  return {
    traceId,
    sessionHash: ownerHash,
    ticketHash: "c".repeat(64),
    classification: {
      category: "billing" as const,
      priority: "medium" as const,
      summary: "Synthetic duplicate charge",
      confidence: 0.9,
    },
    action: { type: "reply" as const },
    citedSources: [{
      citationPosition: 0,
      chunkId,
      sourceId,
      title: "Original title",
      section: "Original section",
      content: "Original exact cited content.",
    }],
    metadata: {
      promptVersions: { classification: "classify.v1", resolution: "resolve.v1" },
      provider: "fake",
      model: "fake-model",
      latencyMs: 10,
      inputTokens: 20,
      outputTokens: 10,
      retryCount: 0,
      validationPassed: true as const,
    },
  };
}

describe("PostgreSQL resolution source repository", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedTestUrl();
    const [{ getDatabase }, { migrate }] = await Promise.all([
      import("@/db/client"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    await migrate(getDatabase(), { migrationsFolder: "drizzle" });
    const [{ deleteResolutionRunsByTraceIds }, { deleteDocumentsBySourceIds }] =
      await Promise.all([
        import("@/db/resolution-runs"),
        import("@/db/knowledge"),
      ]);
    await deleteResolutionRunsByTraceIds(traceIds);
    await deleteDocumentsBySourceIds([sourceId]);
  });

  afterAll(async () => {
    const [
      { deleteResolutionRunsByTraceIds },
      { deleteDocumentsBySourceIds },
      { closeDatabase },
    ] = await Promise.all([
      import("@/db/resolution-runs"),
      import("@/db/knowledge"),
      import("@/db/client"),
    ]);
    await deleteResolutionRunsByTraceIds(traceIds);
    await deleteDocumentsBySourceIds([sourceId]);
    await closeDatabase();
  });

  it("persists cited snapshots transactionally and enforces session ownership", async () => {
    const { replaceDocument, searchDocumentChunks } = await import("@/db/knowledge");
    const { findOwnedSource, persistSuccessfulResolution } = await import(
      "@/db/resolution-runs"
    );
    const base = {
      sourceId,
      title: "Original title",
      metadata: { category: "billing" as const, version: "1" },
    };
    await replaceDocument({
      ...base,
      contentHash: "d".repeat(64),
      chunks: [{
        chunkIndex: 0,
        section: "Original section",
        content: "Original exact cited content.",
        tokenCount: 4,
        embedding: vector(),
        metadata: { sourceId, category: "billing", version: "1" },
      }],
    });
    const rows = await searchDocumentChunks({
      embedding: vector(),
      category: "billing",
      limit: 20,
    });
    const chunk = rows.find((row) => row.metadata.sourceId === sourceId);
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Synthetic integration chunk was not found.");

    await persistSuccessfulResolution(runInput(traceIds[0] as string, chunk.chunkId));
    await expect(findOwnedSource(ownerHash, chunk.chunkId)).resolves.toMatchObject({
      title: "Original title",
      content: "Original exact cited content.",
    });
    await expect(findOwnedSource(otherHash, chunk.chunkId)).resolves.toBeUndefined();
    await expect(
      findOwnedSource(ownerHash, "33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeUndefined();

    await replaceDocument({
      ...base,
      title: "Replacement title",
      contentHash: "e".repeat(64),
      chunks: [{
        chunkIndex: 0,
        section: "Replacement section",
        content: "Replacement current content.",
        tokenCount: 3,
        embedding: vector(),
        metadata: { sourceId, category: "billing", version: "2" },
      }],
    });
    await expect(findOwnedSource(ownerHash, chunk.chunkId)).resolves.toMatchObject({
      title: "Original title",
      section: "Original section",
      content: "Original exact cited content.",
    });

    const duplicateChunkId = "44444444-4444-4444-8444-444444444444";
    const duplicate = runInput(traceIds[1] as string, duplicateChunkId);
    duplicate.citedSources.push({ ...duplicate.citedSources[0]!, citationPosition: 1 });
    await expect(persistSuccessfulResolution(duplicate)).rejects.toBeDefined();
    await expect(findOwnedSource(ownerHash, duplicateChunkId)).resolves.toBeUndefined();
  });
});
