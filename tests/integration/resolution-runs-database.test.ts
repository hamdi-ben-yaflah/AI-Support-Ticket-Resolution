import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

const sourceId = "integration-resolution-source";
const traceIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "99999999-9999-4999-8999-999999999999",
];
const ownerHash = "a".repeat(64);
const otherHash = "b".repeat(64);

function isolatedTestUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (!databaseName.endsWith("_test") || databaseName.length <= 5) {
    throw new Error("Integration tests require a database name ending in _test.");
  }
  return value;
}

function vector(): number[] {
  const value = Array.from({ length: 1_024 }, () => 0);
  value[0] = 1;
  return value;
}

function runInput(traceId: string, chunkId: string) {
  return {
    traceId,
    sessionHash: ownerHash,
    ticketHash: "c".repeat(64),
    classification: {
      category: "billing" as const,
      priority: "medium" as const,
      summary: "Synthetic duplicate charge",
      confidence: 0.9,
    },
    action: { type: "reply" as const, reason: "The evidence supports a reply." },
    citedSources: [{
      citationPosition: 0,
      chunkId,
      sourceId,
      title: "Original title",
      section: "Original section",
      content: "Original exact cited content.",
    }],
    metadata: {
      promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
      resolutionPolicy: { version: "resolution-policy.v1" as const, minimumConfidence: 0.65 },
      provider: "fake",
      model: "fake-model",
      latencyMs: 10,
      inputTokens: 20,
      outputTokens: 10,
      retryCount: 0,
      validationPassed: true as const,
    },
  };
}

describe("PostgreSQL resolution source repository", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedTestUrl();
    const [{ getDatabase }, { migrate }] = await Promise.all([
      import("@/db/client"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    await migrate(getDatabase(), { migrationsFolder: "drizzle" });
    const [{ deleteResolutionRunsByTraceIds }, { deleteDocumentsBySourceIds }] =
      await Promise.all([
        import("@/db/resolution-runs"),
        import("@/db/knowledge"),
      ]);
    await deleteResolutionRunsByTraceIds(traceIds);
    await deleteDocumentsBySourceIds([sourceId]);
  });

  afterAll(async () => {
    const [
      { deleteResolutionRunsByTraceIds },
      { deleteDocumentsBySourceIds },
      { closeDatabase },
    ] = await Promise.all([
      import("@/db/resolution-runs"),
      import("@/db/knowledge"),
      import("@/db/client"),
    ]);
    await deleteResolutionRunsByTraceIds(traceIds);
    await deleteDocumentsBySourceIds([sourceId]);
    await closeDatabase();
  });

  it("persists cited snapshots transactionally and enforces session ownership", async () => {
    const { replaceDocument, searchDocumentChunks } = await import("@/db/knowledge");
    const { findOwnedSource, persistSuccessfulResolution } = await import(
      "@/db/resolution-runs"
    );
    const base = {
      sourceId,
      title: "Original title",
      metadata: { category: "billing" as const, version: "1" },
    };
    await replaceDocument({
      ...base,
      contentHash: "d".repeat(64),
      chunks: [{
        chunkIndex: 0,
        section: "Original section",
        content: "Original exact cited content.",
        tokenCount: 4,
        embedding: vector(),
        metadata: { sourceId, category: "billing", version: "1" },
      }],
    });
    const rows = await searchDocumentChunks({
      embedding: vector(),
      category: "billing",
      limit: 20,
    });
    const chunk = rows.find((row) => row.metadata.sourceId === sourceId);
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Synthetic integration chunk was not found.");

    await persistSuccessfulResolution(runInput(traceIds[0] as string, chunk.chunkId));
    await expect(findOwnedSource(ownerHash, chunk.chunkId)).resolves.toMatchObject({
      title: "Original title",
      content: "Original exact cited content.",
    });
    await expect(findOwnedSource(otherHash, chunk.chunkId)).resolves.toBeUndefined();
    await expect(
      findOwnedSource(ownerHash, "33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeUndefined();

    await replaceDocument({
      ...base,
      title: "Replacement title",
      contentHash: "e".repeat(64),
      chunks: [{
        chunkIndex: 0,
        section: "Replacement section",
        content: "Replacement current content.",
        tokenCount: 3,
        embedding: vector(),
        metadata: { sourceId, category: "billing", version: "2" },
      }],
    });
    await expect(findOwnedSource(ownerHash, chunk.chunkId)).resolves.toMatchObject({
      title: "Original title",
      section: "Original section",
      content: "Original exact cited content.",
    });

    const duplicateChunkId = "44444444-4444-4444-8444-444444444444";
    const duplicate = runInput(traceIds[1] as string, duplicateChunkId);
    duplicate.citedSources.push({ ...duplicate.citedSources[0]!, citationPosition: 1 });
    await expect(persistSuccessfulResolution(duplicate)).rejects.toBeDefined();
    await expect(findOwnedSource(ownerHash, duplicateChunkId)).resolves.toBeUndefined();
  });

  it("persists an abstention without granting source access", async () => {
    const { searchDocumentChunks } = await import("@/db/knowledge");
    const { getDatabase } = await import("@/db/client");
    const { resolutionRuns } = await import("@/db/schema");
    const { findOwnedSource, persistSuccessfulResolution } = await import(
      "@/db/resolution-runs"
    );
    const rows = await searchDocumentChunks({
      embedding: vector(),
      category: "billing",
      limit: 20,
    });
    const chunk = rows.find((row) => row.metadata.sourceId === sourceId);
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Synthetic integration chunk was not found.");

    const abstention = {
      ...runInput(traceIds[2] as string, chunk.chunkId),
      sessionHash: otherHash,
      action: {
        type: "needs_human_review" as const,
        reason: "The available evidence is insufficient for a safe reply.",
      },
      citedSources: [],
    };
    await expect(persistSuccessfulResolution(abstention)).resolves.toBeUndefined();
    const [stored] = await getDatabase()
      .select({
        action: resolutionRuns.action,
        resultStatus: resolutionRuns.resultStatus,
      })
      .from(resolutionRuns)
      .where(eq(resolutionRuns.traceId, abstention.traceId));
    expect(stored).toEqual({
      action: abstention.action,
      resultStatus: "success",
    });
    await expect(findOwnedSource(otherHash, chunk.chunkId)).resolves.toBeUndefined();
  });

  it("persists, owns, and executes a refund-review proposal exactly once", async () => {
    const { searchDocumentChunks } = await import("@/db/knowledge");
    const { getDatabase } = await import("@/db/client");
    const { actionAudit } = await import("@/db/schema");
    const { confirmOwnedRefundReview } = await import("@/db/action-audit");
    const {
      deleteResolutionRunsByTraceIds,
      persistSuccessfulResolution,
    } = await import("@/db/resolution-runs");
    const rows = await searchDocumentChunks({
      embedding: vector(),
      category: "billing",
      limit: 20,
    });
    const chunk = rows.find((row) => row.metadata.sourceId === sourceId);
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Synthetic integration chunk was not found.");

    const proposalId = "55555555-5555-4555-8555-555555555555";
    const reason = "The settled duplicate-charge policy supports a refund review.";
    const arguments_ = {
      reason,
      ticketSummary: "Synthetic duplicate charge",
      evidenceChunkIds: [chunk.chunkId],
    };
    const refundRun = {
      ...runInput(traceIds[3] as string, chunk.chunkId),
      action: {
        type: "request_refund_review" as const,
        reason,
        proposal: {
          proposalId,
          toolName: "requestRefundReview" as const,
          state: "pending_confirmation" as const,
          arguments: arguments_,
        },
      },
    };
    await persistSuccessfulResolution(refundRun);
    const [pending] = await getDatabase()
      .select()
      .from(actionAudit)
      .where(eq(actionAudit.proposalId, proposalId));
    expect(pending).toMatchObject({
      proposalId,
      state: "pending_confirmation",
      proposedArguments: arguments_,
      confirmedAt: null,
      executedAt: null,
      result: null,
    });

    await expect(confirmOwnedRefundReview({
      proposalId,
      sessionHash: otherHash,
      traceId: "66666666-6666-4666-8666-666666666666",
    })).rejects.toEqual(expect.objectContaining({
      code: "not_found",
    }));

    let executorCalls = 0;
    const executedAt = new Date("2026-09-12T10:00:00.000Z");
    const executor = async (
      _arguments: typeof arguments_,
      context: { proposalId: string; executedAt: Date },
    ) => {
      executorCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        proposalId: context.proposalId,
        status: "mock_review_recorded" as const,
        message: "A local mock record was created. No refund was approved or issued.",
        executedAt: context.executedAt.toISOString(),
      };
    };
    const confirmations = await Promise.all([
      confirmOwnedRefundReview(
        {
          proposalId,
          sessionHash: ownerHash,
          traceId: "77777777-7777-4777-8777-777777777777",
        },
        { executor, now: () => executedAt },
      ),
      confirmOwnedRefundReview(
        {
          proposalId,
          sessionHash: ownerHash,
          traceId: "88888888-8888-4888-8888-888888888888",
        },
        { executor, now: () => new Date("2026-09-12T11:00:00.000Z") },
      ),
    ]);
    expect(executorCalls).toBe(1);
    expect(confirmations[0]).toEqual(confirmations[1]);

    const [executed] = await getDatabase()
      .select()
      .from(actionAudit)
      .where(eq(actionAudit.proposalId, proposalId));
    expect(executed).toMatchObject({
      state: "executed",
      confirmedAt: executedAt,
      executedAt,
      result: confirmations[0],
    });

    await deleteResolutionRunsByTraceIds([traceIds[3] as string]);
    await expect(
      getDatabase()
        .select()
        .from(actionAudit)
        .where(eq(actionAudit.proposalId, proposalId)),
    ).resolves.toEqual([]);
  });

  it("revalidates stored arguments and evidence before mock execution", async () => {
    const { searchDocumentChunks } = await import("@/db/knowledge");
    const { getDatabase } = await import("@/db/client");
    const { actionAudit } = await import("@/db/schema");
    const {
      ActionAuditRepositoryError,
      confirmOwnedRefundReview,
    } = await import("@/db/action-audit");
    const { persistSuccessfulResolution } = await import("@/db/resolution-runs");
    const rows = await searchDocumentChunks({
      embedding: vector(),
      category: "billing",
      limit: 20,
    });
    const chunk = rows.find((row) => row.metadata.sourceId === sourceId);
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error("Synthetic integration chunk was not found.");

    const proposalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reason = "The settled duplicate-charge policy supports a refund review.";
    const refundRun = {
      ...runInput(traceIds[4] as string, chunk.chunkId),
      action: {
        type: "request_refund_review" as const,
        reason,
        proposal: {
          proposalId,
          toolName: "requestRefundReview" as const,
          state: "pending_confirmation" as const,
          arguments: {
            reason,
            ticketSummary: "Synthetic duplicate charge",
            evidenceChunkIds: [chunk.chunkId],
          },
        },
      },
    };
    await persistSuccessfulResolution(refundRun);
    await getDatabase()
      .update(actionAudit)
      .set({
        proposedArguments: {
          ...refundRun.action.proposal.arguments,
          evidenceChunkIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        },
      })
      .where(eq(actionAudit.proposalId, proposalId));

    let executorCalls = 0;
    await expect(confirmOwnedRefundReview(
      {
        proposalId,
        sessionHash: ownerHash,
        traceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
      {
        executor: (_arguments, context) => {
          executorCalls += 1;
          return {
            proposalId: context.proposalId,
            status: "mock_review_recorded",
            message: "A local mock record was created. No refund was approved or issued.",
            executedAt: context.executedAt.toISOString(),
          };
        },
      },
    )).rejects.toBeInstanceOf(ActionAuditRepositoryError);
    expect(executorCalls).toBe(0);
    const [stored] = await getDatabase()
      .select({
        state: actionAudit.state,
        result: actionAudit.result,
        executedAt: actionAudit.executedAt,
      })
      .from(actionAudit)
      .where(eq(actionAudit.proposalId, proposalId));
    expect(stored).toEqual({
      state: "pending_confirmation",
      result: null,
      executedAt: null,
    });
  });
});
