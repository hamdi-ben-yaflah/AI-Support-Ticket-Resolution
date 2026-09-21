import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db/client";
import { actionAudit, resolutionRuns, resolutionRunSources } from "@/db/schema";
import { PersistedResolutionRunSchema, type PersistedResolutionRun } from "@/domain/resolution-run";
import { SourceDetailSchema, type SourceDetail } from "@/domain/source";

const OwnedSourceLookupSchema = z
  .object({
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    chunkId: z.string().uuid(),
  })
  .strict();

export async function persistSuccessfulResolution(raw: PersistedResolutionRun): Promise<void> {
  const input = PersistedResolutionRunSchema.parse(raw);

  await getDatabase().transaction(async (transaction) => {
    const [run] = await transaction
      .insert(resolutionRuns)
      .values({
        traceId: input.traceId,
        sessionHash: input.sessionHash,
        ticketHash: input.ticketHash,
        promptVersions: input.metadata.promptVersions,
        provider: input.metadata.provider,
        models: input.metadata.models ?? {
          classification: input.metadata.model!,
          resolution: input.metadata.model!,
        },
        resultStatus: "success",
        classification: input.classification,
        action: input.action,
        latencyMs: input.metadata.latencyMs,
        inputTokens: input.metadata.inputTokens,
        outputTokens: input.metadata.outputTokens,
        validationPassed: input.metadata.validationPassed,
        retryCount: input.metadata.retryCount,
      })
      .returning({ id: resolutionRuns.id });

    if (!run) throw new Error("Resolution run insert returned no identifier.");

    if (input.citedSources.length > 0) {
      await transaction.insert(resolutionRunSources).values(
        input.citedSources.map((source) => ({
          resolutionRunId: run.id,
          citationPosition: source.citationPosition,
          chunkId: source.chunkId,
          sourceId: source.sourceId,
          title: source.title,
          section: source.section,
          content: source.content,
        })),
      );
    }

    if (input.action.type === "request_refund_review") {
      const citedIds = new Set(input.citedSources.map((source) => source.chunkId));
      if (
        input.action.proposal.arguments.evidenceChunkIds.some((chunkId) => !citedIds.has(chunkId))
      ) {
        throw new Error("Action evidence does not belong to the resolution run.");
      }
      await transaction.insert(actionAudit).values({
        proposalId: input.action.proposal.proposalId,
        resolutionRunId: run.id,
        proposedArguments: input.action.proposal.arguments,
        state: input.action.proposal.state,
        traceId: input.traceId,
      });
    }
  });
}

export async function findOwnedSource(
  sessionHash: string,
  chunkId: string,
): Promise<SourceDetail | undefined> {
  const lookup = OwnedSourceLookupSchema.parse({ sessionHash, chunkId });
  const [row] = await getDatabase()
    .select({
      chunkId: resolutionRunSources.chunkId,
      sourceId: resolutionRunSources.sourceId,
      title: resolutionRunSources.title,
      section: resolutionRunSources.section,
      content: resolutionRunSources.content,
    })
    .from(resolutionRunSources)
    .innerJoin(resolutionRuns, eq(resolutionRunSources.resolutionRunId, resolutionRuns.id))
    .where(
      and(
        eq(resolutionRuns.sessionHash, lookup.sessionHash),
        eq(resolutionRunSources.chunkId, lookup.chunkId),
        eq(resolutionRuns.resultStatus, "success"),
      ),
    )
    .orderBy(desc(resolutionRuns.createdAt), desc(resolutionRuns.id))
    .limit(1);

  return row ? SourceDetailSchema.parse(row) : undefined;
}

export async function deleteResolutionRunsByTraceIds(traceIds: readonly string[]): Promise<void> {
  if (traceIds.length === 0) return;
  await getDatabase()
    .delete(resolutionRuns)
    .where(inArray(resolutionRuns.traceId, [...traceIds]));
}
