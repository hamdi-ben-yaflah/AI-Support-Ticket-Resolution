import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const [{ inspectDocumentChunks }, inspection] = await Promise.all([
    import("../src/db/knowledge"),
    import("../src/ingestion/inspection"),
  ]);
  const chunks = await inspectDocumentChunks();

  for (const chunk of chunks) {
    process.stdout.write(`${inspection.formatKnowledgeChunkInspection(chunk)}\n`);
  }
  process.stdout.write(`${inspection.formatKnowledgeChunkInspectionSummary(chunks.length)}\n`);
}

main()
  .catch(() => {
    process.stderr.write(
      `${JSON.stringify({
        event: "chunk_inspection_failed",
        reason: "Unable to inspect stored knowledge chunks.",
      })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeDatabase } = await import("../src/db/client");
    await closeDatabase();
  });
