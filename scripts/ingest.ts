import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const [{ getEmbeddingConfig }, database, embedding, ingestion] = await Promise.all([
    import("../src/config/embedding"),
    import("../src/db/knowledge"),
    import("../src/embeddings/providers/voyage"),
    import("../src/ingestion/ingest"),
  ]);
  const config = getEmbeddingConfig();
  const embedder = new embedding.VoyageEmbeddingProvider({
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
  const documents = await ingestion.readKnowledgeBaseDirectory(
    resolve(process.cwd(), "data/knowledge-base"),
  );
  const summary = await ingestion.ingestKnowledgeBase({
    documents,
    embedder,
    batchSize: config.batchSize,
    traceId: randomUUID(),
    repository: {
      getContentHashes: database.getDocumentContentHashes,
      replaceDocument: database.replaceDocument,
    },
  });

  process.stdout.write(`${JSON.stringify({ event: "ingestion_completed", ...summary })}\n`);
}

main()
  .catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : "Unknown ingestion failure.";
    process.stderr.write(`${JSON.stringify({ event: "ingestion_failed", reason })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeDatabase } = await import("../src/db/client");
    await closeDatabase();
  });
