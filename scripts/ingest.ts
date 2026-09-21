import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const [configuration, database, embedding, ingestion, replay] = await Promise.all([
    import("../src/config/embedding"),
    import("../src/db/knowledge"),
    import("../src/embeddings/providers/voyage"),
    import("../src/ingestion/ingest"),
    import("../src/evals/replay"),
  ]);
  const mode = process.env.INGESTION_MODE ?? "live";
  if (mode !== "live" && mode !== "record" && mode !== "replay") {
    throw new Error("Ingestion mode is invalid.");
  }
  let batchSize = 64;
  let embedder;
  if (mode === "replay") {
    const manifest = await replay.loadCassetteManifest();
    embedder = replay.createReplayEmbeddingProvider(
      manifest.embeddings.model,
      manifest.embeddings.dimensions,
    );
    batchSize = manifest.embeddings.batchSize;
  } else {
    const config = configuration.getEmbeddingConfig();
    batchSize = config.batchSize;
    const live = new embedding.VoyageEmbeddingProvider({
      apiKey: config.apiKey,
      model: config.model,
      dimensions: config.dimensions,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    embedder = mode === "record" ? replay.createRecordingEmbeddingProvider(live) : live;
  }
  const documents = await ingestion.readKnowledgeBaseDirectory(
    resolve(process.cwd(), "data/knowledge-base"),
  );
  const summary = await ingestion.ingestKnowledgeBase({
    documents,
    embedder,
    batchSize,
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
