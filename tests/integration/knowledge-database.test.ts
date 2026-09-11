import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sourceId = "integration-vector-source";

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

function vector(first: number, second: number): number[] {
  const value = Array.from({ length: 1_024 }, () => 0);
  value[0] = first;
  value[1] = second;
  return value;
}

describe("PostgreSQL knowledge repository", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedTestUrl();
    const [{ getDatabase }, { migrate }] = await Promise.all([
      import("@/db/client"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    await migrate(getDatabase(), { migrationsFolder: "drizzle" });
    const { deleteDocumentsBySourceIds } = await import("@/db/knowledge");
    await deleteDocumentsBySourceIds([sourceId]);
  });

  afterAll(async () => {
    const [{ deleteDocumentsBySourceIds }, { closeDatabase }] = await Promise.all([
      import("@/db/knowledge"),
      import("@/db/client"),
    ]);
    await deleteDocumentsBySourceIds([sourceId]);
    await closeDatabase();
  });

  it("persists, replaces, and retrieves categorized vectors", async () => {
    const { getDocumentContentHashes, replaceDocument, searchDocumentChunks } = await import("@/db/knowledge");
    const base = {
      sourceId,
      title: "Integration source",
      metadata: { category: "billing" as const, version: "1" },
    };
    await replaceDocument({ ...base, contentHash: "a".repeat(64), chunks: [{ chunkIndex: 0, section: "First", content: "First content", tokenCount: 2, embedding: vector(1, 0), metadata: { sourceId, category: "billing", version: "1" } }] });
    expect(await getDocumentContentHashes([sourceId])).toEqual(new Map([[sourceId, "a".repeat(64)]]));

    await replaceDocument({ ...base, contentHash: "b".repeat(64), chunks: [{ chunkIndex: 0, section: "Replacement", content: "Replacement content", tokenCount: 2, embedding: vector(0, 1), metadata: { sourceId, category: "billing", version: "1" } }] });
    const result = await searchDocumentChunks({ embedding: vector(0, 1), category: "billing", limit: 5 });
    expect(result.filter((row) => row.metadata.sourceId === sourceId)).toHaveLength(1);
    expect(result.find((row) => row.metadata.sourceId === sourceId)).toMatchObject({ section: "Replacement", similarity: 1 });
  });
});
