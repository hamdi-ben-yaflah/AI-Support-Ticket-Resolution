import { LlmError } from "@/ai/errors";
import {
  GroundedReplySchema,
  type GroundedReply,
} from "@/domain/grounded-reply";
import type { RetrievedEvidence } from "@/retrieval/types";

export function validateGroundedReply(
  value: unknown,
  evidence: readonly RetrievedEvidence[],
): GroundedReply {
  const parsed = GroundedReplySchema.safeParse(value);
  if (!parsed.success) {
    throw new LlmError("invalid_output", "The grounded reply is invalid.", {
      retryable: false,
    });
  }

  const evidenceById = new Map(evidence.map((item) => [item.chunkId, item]));
  const citedIds = new Set<string>();
  for (const citation of parsed.data.citations) {
    const source = evidenceById.get(citation.chunkId);
    if (
      !source ||
      source.sourceId !== citation.sourceId ||
      source.section !== citation.section ||
      citedIds.has(citation.chunkId)
    ) {
      throw new LlmError("invalid_output", "The grounded reply has invalid citations.", {
        retryable: false,
      });
    }
    citedIds.add(citation.chunkId);
  }

  return parsed.data;
}
