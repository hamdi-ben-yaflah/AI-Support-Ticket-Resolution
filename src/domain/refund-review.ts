import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";

const UniqueEvidenceChunkIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(5)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Evidence chunk identifiers must be unique.",
      });
    }
  });

export const RequestRefundReviewArgsSchema = z
  .object({
    reason: z.string().trim().min(10).max(500),
    ticketSummary: ClassificationSchema.shape.summary,
    evidenceChunkIds: UniqueEvidenceChunkIdsSchema,
  })
  .strict();

export const RefundReviewActionProposalSchema = z
  .object({
    proposalId: z.string().uuid(),
    toolName: z.literal("requestRefundReview"),
    state: z.literal("pending_confirmation"),
    arguments: RequestRefundReviewArgsSchema,
  })
  .strict();

export const RefundReviewConfirmationSchema = z
  .object({ confirmed: z.literal(true) })
  .strict();

export const MockRefundReviewResultSchema = z
  .object({
    proposalId: z.string().uuid(),
    status: z.literal("mock_review_recorded"),
    message: z
      .string()
      .trim()
      .min(1)
      .max(300),
    executedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RequestRefundReviewArgs = z.infer<
  typeof RequestRefundReviewArgsSchema
>;
export type RefundReviewActionProposal = z.infer<
  typeof RefundReviewActionProposalSchema
>;
export type MockRefundReviewResult = z.infer<
  typeof MockRefundReviewResultSchema
>;
