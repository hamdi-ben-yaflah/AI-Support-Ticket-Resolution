import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";
import { RefundReviewActionProposalSchema } from "@/domain/refund-review";

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

export const RefundReviewResolutionProposalSchema = ClassificationSchema.extend({
  category: z.literal("billing"),
  action: z.literal("request_refund_review"),
  reason: ResolutionReasonSchema,
  groundedReply: GroundedReplySchema,
  actionProposal: RefundReviewActionProposalSchema,
})
  .strict()
  .superRefine((proposal, context) => {
    const citationIds = proposal.groundedReply.citations.map(
      (citation) => citation.chunkId,
    );
    const evidenceIds = proposal.actionProposal.arguments.evidenceChunkIds;
    if (
      citationIds.length !== evidenceIds.length ||
      citationIds.some((id, index) => evidenceIds[index] !== id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionProposal", "arguments", "evidenceChunkIds"],
        message: "Action evidence must exactly match the grounded citations.",
      });
    }
    if (proposal.actionProposal.arguments.ticketSummary !== proposal.summary) {
      context.addIssue({
        code: "custom",
        path: ["actionProposal", "arguments", "ticketSummary"],
        message: "The action summary must match the validated ticket summary.",
      });
    }
    if (proposal.actionProposal.arguments.reason !== proposal.reason) {
      context.addIssue({
        code: "custom",
        path: ["actionProposal", "arguments", "reason"],
        message: "The action reason must match the validated resolution reason.",
      });
    }
  });

export const ResolutionProposalSchema = z.discriminatedUnion("action", [
  ReplyResolutionProposalSchema,
  RefundReviewResolutionProposalSchema,
  HumanReviewResolutionProposalSchema,
]);

export type Citation = z.infer<typeof CitationSchema>;
export type GroundedReply = z.infer<typeof GroundedReplySchema>;
export type ReplyResolutionProposal = z.infer<typeof ReplyResolutionProposalSchema>;
export type RefundReviewResolutionProposal = z.infer<
  typeof RefundReviewResolutionProposalSchema
>;
export type HumanReviewResolutionProposal = z.infer<
  typeof HumanReviewResolutionProposalSchema
>;
export type ResolutionProposal = z.infer<typeof ResolutionProposalSchema>;
