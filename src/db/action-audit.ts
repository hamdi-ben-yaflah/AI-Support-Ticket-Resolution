import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  executeMockRefundReview,
  type MockRefundReviewExecutor,
} from "@/actions/request-refund-review";
import { getDatabase } from "@/db/client";
import { actionAudit, resolutionRuns, resolutionRunSources } from "@/db/schema";
import {
  MockRefundReviewResultSchema,
  RequestRefundReviewArgsSchema,
  type MockRefundReviewResult,
} from "@/domain/refund-review";
import { ClassificationSchema } from "@/domain/classification";
import { ResolutionActionSchema } from "@/domain/resolution-run";

const ConfirmationInputSchema = z
  .object({
    proposalId: z.string().uuid(),
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    traceId: z.string().uuid(),
  })
  .strict();

const AuditStateSchema = z.enum(["pending_confirmation", "executed"]);

export class ActionAuditRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "unavailable",
    cause?: unknown,
  ) {
    super("The mock refund-review action is unavailable.", { cause });
    this.name = "ActionAuditRepositoryError";
  }
}

type ConfirmDependencies = {
  executor?: MockRefundReviewExecutor;
  now?: () => Date;
};

function sameArguments(
  left: z.infer<typeof RequestRefundReviewArgsSchema>,
  right: z.infer<typeof RequestRefundReviewArgsSchema>,
): boolean {
  return (
    left.reason === right.reason &&
    left.ticketSummary === right.ticketSummary &&
    left.evidenceChunkIds.length === right.evidenceChunkIds.length &&
    left.evidenceChunkIds.every((chunkId, index) => right.evidenceChunkIds[index] === chunkId)
  );
}

export async function confirmOwnedRefundReview(
  rawInput: z.input<typeof ConfirmationInputSchema>,
  dependencies: ConfirmDependencies = {},
): Promise<MockRefundReviewResult> {
  const input = ConfirmationInputSchema.parse(rawInput);
  const executor = dependencies.executor ?? executeMockRefundReview;
  const now = dependencies.now ?? (() => new Date());

  try {
    return await getDatabase().transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          resolutionRunId: actionAudit.resolutionRunId,
          state: actionAudit.state,
          proposedArguments: actionAudit.proposedArguments,
          result: actionAudit.result,
          action: resolutionRuns.action,
          classification: resolutionRuns.classification,
        })
        .from(actionAudit)
        .innerJoin(resolutionRuns, eq(actionAudit.resolutionRunId, resolutionRuns.id))
        .where(
          and(
            eq(actionAudit.proposalId, input.proposalId),
            eq(resolutionRuns.sessionHash, input.sessionHash),
            eq(resolutionRuns.resultStatus, "success"),
          ),
        )
        .for("update", { of: actionAudit })
        .limit(1);

      if (!row) throw new ActionAuditRepositoryError("not_found");

      const state = AuditStateSchema.parse(row.state);
      if (state === "executed") {
        const result = MockRefundReviewResultSchema.parse(row.result);
        if (result.proposalId !== input.proposalId) {
          throw new ActionAuditRepositoryError("unavailable");
        }
        return result;
      }

      const storedAction = ResolutionActionSchema.parse(row.action);
      const classification = ClassificationSchema.parse(row.classification);
      const arguments_ = RequestRefundReviewArgsSchema.parse(row.proposedArguments);
      if (
        storedAction.type !== "request_refund_review" ||
        classification.category !== "billing" ||
        classification.summary !== arguments_.ticketSummary ||
        storedAction.reason !== arguments_.reason ||
        storedAction.proposal.proposalId !== input.proposalId ||
        storedAction.proposal.toolName !== "requestRefundReview" ||
        storedAction.proposal.state !== "pending_confirmation" ||
        !sameArguments(storedAction.proposal.arguments, arguments_)
      ) {
        throw new ActionAuditRepositoryError("unavailable");
      }

      const evidenceRows = await transaction
        .select({ chunkId: resolutionRunSources.chunkId })
        .from(resolutionRunSources)
        .where(
          and(
            eq(resolutionRunSources.resolutionRunId, row.resolutionRunId),
            inArray(resolutionRunSources.chunkId, arguments_.evidenceChunkIds),
          ),
        );
      const ownedEvidenceIds = new Set(evidenceRows.map((source) => source.chunkId));
      if (
        ownedEvidenceIds.size !== arguments_.evidenceChunkIds.length ||
        arguments_.evidenceChunkIds.some((chunkId) => !ownedEvidenceIds.has(chunkId))
      ) {
        throw new ActionAuditRepositoryError("unavailable");
      }

      const executedAt = now();
      const result = MockRefundReviewResultSchema.parse(
        await executor(arguments_, {
          proposalId: input.proposalId,
          executedAt,
        }),
      );
      if (
        result.proposalId !== input.proposalId ||
        result.executedAt !== executedAt.toISOString()
      ) {
        throw new ActionAuditRepositoryError("unavailable");
      }

      const updated = await transaction
        .update(actionAudit)
        .set({
          state: "executed",
          confirmedAt: executedAt,
          executedAt,
          result,
        })
        .where(
          and(
            eq(actionAudit.proposalId, input.proposalId),
            eq(actionAudit.state, "pending_confirmation"),
          ),
        )
        .returning({ proposalId: actionAudit.proposalId });
      if (updated.length !== 1) {
        throw new ActionAuditRepositoryError("unavailable");
      }

      return result;
    });
  } catch (error) {
    if (error instanceof ActionAuditRepositoryError) throw error;
    throw new ActionAuditRepositoryError("unavailable", error);
  }
}
