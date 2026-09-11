import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";

export const CitationSchema = z.object({
  chunkId: z.string().uuid(),
  sourceId: z.string().trim().min(1).max(120),
  section: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(300),
});

export const GroundedReplySchema = z.object({
  suggestedResponse: z.string().trim().min(1).max(4_000),
  citations: z.array(CitationSchema).min(1).max(8),
});

export const ResolutionProposalSchema = ClassificationSchema.extend({
  groundedReply: GroundedReplySchema,
});

export type Citation = z.infer<typeof CitationSchema>;
export type GroundedReply = z.infer<typeof GroundedReplySchema>;
export type ResolutionProposal = z.infer<typeof ResolutionProposalSchema>;
