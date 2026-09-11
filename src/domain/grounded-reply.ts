import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";

export const CitationSchema = z.object({
  chunkId: z.string().uuid(),
  sourceId: z.string().trim().min(1).max(120),
  section: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(300),
}).strict();

export const GroundedReplySchema = z.object({
  suggestedResponse: z.string().trim().min(1).max(4_000),
  citations: z.array(CitationSchema).min(1).max(8),
}).strict();

export const ResolutionReasonSchema = z.string().trim().min(1).max(300);

export const ReplyResolutionProposalSchema = ClassificationSchema.extend({
  action: z.literal("reply"),
  reason: ResolutionReasonSchema,
  groundedReply: GroundedReplySchema,
}).strict();

export const HumanReviewResolutionProposalSchema = ClassificationSchema.extend({
  action: z.literal("needs_human_review"),
  reason: ResolutionReasonSchema,
}).strict();

export const ResolutionProposalSchema = z.discriminatedUnion("action", [
  ReplyResolutionProposalSchema,
  HumanReviewResolutionProposalSchema,
]);

export type Citation = z.infer<typeof CitationSchema>;
export type GroundedReply = z.infer<typeof GroundedReplySchema>;
export type ReplyResolutionProposal = z.infer<typeof ReplyResolutionProposalSchema>;
export type HumanReviewResolutionProposal = z.infer<
  typeof HumanReviewResolutionProposalSchema
>;
export type ResolutionProposal = z.infer<typeof ResolutionProposalSchema>;
