import type { RetrievedEvidence } from "@/retrieval/types";

export function buildEvidenceContext(evidence: readonly RetrievedEvidence[]): string {
  return evidence
    .map((item) =>
      [
        `--- BEGIN UNTRUSTED KNOWLEDGE CHUNK ${item.chunkId} ---`,
        `sourceId: ${item.sourceId}`,
        `section: ${item.section}`,
        item.content,
        `--- END UNTRUSTED KNOWLEDGE CHUNK ${item.chunkId} ---`,
      ].join("\n"),
    )
    .join("\n\n");
}
