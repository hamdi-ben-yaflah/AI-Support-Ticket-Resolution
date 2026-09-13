import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";
import { ResolutionProposalSchema } from "@/domain/grounded-reply";
import { SourceDetailSchema } from "@/domain/source";
import { RefundReviewActionProposalSchema } from "@/domain/refund-review";

export const PromptVersionsSchema = z
  .object({
    classification: z.string().trim().min(1).max(120),
    resolution: z.string().trim().min(1).max(120),
  })
  .strict();

export const ResolutionActionSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("reply"),
        reason: z.string().trim().min(1).max(300),
      })
      .strict(),
    z
      .object({
        type: z.literal("request_refund_review"),
        reason: z.string().trim().min(10).max(300),
        proposal: RefundReviewActionProposalSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("needs_human_review"),
        reason: z.string().trim().min(1).max(300),
      })
      .strict(),
  ]);

export const ResolutionPolicyMetadataSchema = z
  .object({
    version: z.literal("resolution-policy.v1"),
    minimumConfidence: z.number().min(0).max(1),
  })
  .strict();

export const ResolutionRunMetadataSchema = z
  .object({
    promptVersions: PromptVersionsSchema,
    resolutionPolicy: ResolutionPolicyMetadataSchema,
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    latencyMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    validationPassed: z.literal(true),
  })
  .strict();

export const CitedSourceSnapshotSchema = SourceDetailSchema.extend({
  citationPosition: z.number().int().nonnegative(),
}).strict();

export const ResolutionExecutionSchema = z
  .object({
    proposal: ResolutionProposalSchema,
    citedSources: z.array(CitedSourceSnapshotSchema).max(8),
    metadata: ResolutionRunMetadataSchema,
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.proposal.action === "needs_human_review") {
      if (execution.citedSources.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["citedSources"],
          message: "Human-review outcomes cannot grant cited sources.",
        });
      }
      return;
    }

    const citations = execution.proposal.groundedReply.citations;
    if (execution.citedSources.length !== citations.length) {
      context.addIssue({
        code: "custom",
        path: ["citedSources"],
        message: "Cited source snapshots must match the validated citations.",
      });
      return;
    }

    for (const [position, source] of execution.citedSources.entries()) {
      const citation = citations[position];
      if (
        !citation ||
        source.citationPosition !== position ||
        source.chunkId !== citation.chunkId ||
        source.sourceId !== citation.sourceId ||
        source.section !== citation.section
      ) {
        context.addIssue({
          code: "custom",
          path: ["citedSources", position],
          message: "Cited source provenance is missing, reordered, or mismatched.",
        });
      }
    }
  });

export const PersistedResolutionRunSchema = z
  .object({
    traceId: z.string().uuid(),
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    ticketHash: z.string().regex(/^[a-f0-9]{64}$/),
    classification: ClassificationSchema,
    action: ResolutionActionSchema,
    citedSources: z.array(CitedSourceSnapshotSchema).max(8),
    metadata: ResolutionRunMetadataSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.action.type === "reply" && run.citedSources.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["citedSources"],
        message: "Reply runs require cited source snapshots.",
      });
    }
    if (run.action.type === "needs_human_review" && run.citedSources.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["citedSources"],
        message: "Human-review runs cannot grant cited sources.",
      });
    }
    if (run.action.type === "request_refund_review") {
      if (run.classification.category !== "billing" || run.citedSources.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["action"],
          message: "Refund-review runs require billing classification and cited sources.",
        });
      }
      const sourceIds = run.citedSources.map((source) => source.chunkId);
      const evidenceIds = run.action.proposal.arguments.evidenceChunkIds;
      if (
        sourceIds.length !== evidenceIds.length ||
        sourceIds.some((id, index) => evidenceIds[index] !== id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["action", "proposal", "arguments", "evidenceChunkIds"],
          message: "Refund-review evidence must match this run's cited sources.",
        });
      }
      if (
        run.action.reason !== run.action.proposal.arguments.reason ||
        run.classification.summary !==
          run.action.proposal.arguments.ticketSummary
      ) {
        context.addIssue({
          code: "custom",
          path: ["action", "proposal", "arguments"],
          message: "Refund-review arguments must match the validated resolution.",
        });
      }
    }
    if (
      run.action.type !== "request_refund_review" &&
      "proposal" in run.action
    ) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Only refund-review runs may persist action proposals.",
      });
    }
  });

export type ResolutionExecution = z.infer<typeof ResolutionExecutionSchema>;
export type ResolutionRunMetadata = z.infer<typeof ResolutionRunMetadataSchema>;
export type PersistedResolutionRun = z.infer<typeof PersistedResolutionRunSchema>;
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;
export type ResolutionAction = z.infer<typeof ResolutionActionSchema>;
