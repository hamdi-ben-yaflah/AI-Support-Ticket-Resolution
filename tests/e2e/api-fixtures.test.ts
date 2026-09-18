import { describe, expect, it } from "vitest";

import { createApiResultSchema } from "@/domain/api-result";
import { ResolutionProposalSchema } from "@/domain/grounded-reply";
import { MockRefundReviewResultSchema } from "@/domain/refund-review";
import { SourceDetailSchema } from "@/domain/source";
import { createApiFixtures, FIXTURE_IDS } from "../../e2e/support/api-fixtures";

describe("Playwright API fixtures", () => {
  it("constructs schema-valid response fixtures for every supported journey", () => {
    const fixtures = createApiFixtures();
    const resolution = createApiResultSchema(ResolutionProposalSchema);
    const source = createApiResultSchema(SourceDetailSchema);
    const confirmationSchema = createApiResultSchema(MockRefundReviewResultSchema);

    expect(resolution.parse(fixtures.resolution.reply).ok).toBe(true);
    expect(resolution.parse(fixtures.resolution.refundReview).ok).toBe(true);
    expect(resolution.parse(fixtures.resolution.humanReview).ok).toBe(true);
    expect(resolution.parse(fixtures.resolution.retryableFailure)).toMatchObject({
      ok: false,
      error: { code: "provider_timeout", retryable: true },
    });
    const replySource = source.parse(fixtures.source.reply);
    const refundSource = source.parse(fixtures.source.refundReview);
    expect(replySource.ok && replySource.data).toMatchObject({ chunkId: FIXTURE_IDS.replyChunk });
    expect(refundSource.ok && refundSource.data).toMatchObject({
      chunkId: FIXTURE_IDS.refundChunk,
    });
    expect(source.parse(fixtures.source.unavailable)).toMatchObject({
      ok: false,
      error: { code: "source_unavailable", retryable: true },
    });
    const confirmation = confirmationSchema.parse(fixtures.confirmation.success);
    expect(confirmation.ok && confirmation.data).toMatchObject({
      proposalId: FIXTURE_IDS.refundProposal,
      status: "mock_review_recorded",
    });
    expect(confirmationSchema.parse(fixtures.confirmation.unavailable)).toMatchObject({
      ok: false,
      error: { code: "action_unavailable", retryable: true },
    });
  });
});
