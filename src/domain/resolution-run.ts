import { z } from "zod";

import { ClassificationSchema } from "@/domain/classification";
import { ResolutionProposalSchema } from "@/domain/grounded-reply";
import { SourceDetailSchema } from "@/domain/source";

export const PromptVersionsSchema = z
  .object({
    classification: z.string().trim().min(1).max(120),
    resolution: z.string().trim().min(1).max(120),
  })
  .strict();

export const ResolutionActionSchema = z
  .object({
    type: z.literal("reply"),
  })
  .strict();

export const ResolutionRunMetadataSchema = z
  .object({
    promptVersions: PromptVersionsSchema,
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
    citedSources: z.array(CitedSourceSnapshotSchema).min(1).max(8),
    metadata: ResolutionRunMetadataSchema,
  })
  .strict()
  .superRefine((execution, context) => {
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
    citedSources: z.array(CitedSourceSnapshotSchema).min(1).max(8),
    metadata: ResolutionRunMetadataSchema,
  })
  .strict();

export type ResolutionExecution = z.infer<typeof ResolutionExecutionSchema>;
export type ResolutionRunMetadata = z.infer<typeof ResolutionRunMetadataSchema>;
export type PersistedResolutionRun = z.infer<typeof PersistedResolutionRunSchema>;
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;
export type ResolutionAction = z.infer<typeof ResolutionActionSchema>;
