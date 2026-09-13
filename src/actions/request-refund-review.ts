import {
  MockRefundReviewResultSchema,
  RequestRefundReviewArgsSchema,
  type MockRefundReviewResult,
  type RequestRefundReviewArgs,
} from "@/domain/refund-review";

const MOCK_RESULT_MESSAGE =
  "A local mock refund-review record was created. No refund was approved or issued.";

export type MockRefundReviewExecutor = (
  arguments_: RequestRefundReviewArgs,
  context: { proposalId: string; executedAt: Date },
) => MockRefundReviewResult | Promise<MockRefundReviewResult>;

export function executeMockRefundReview(
  rawArguments: RequestRefundReviewArgs,
  context: { proposalId: string; executedAt: Date },
): MockRefundReviewResult {
  RequestRefundReviewArgsSchema.parse(rawArguments);
  return MockRefundReviewResultSchema.parse({
    proposalId: context.proposalId,
    status: "mock_review_recorded",
    message: MOCK_RESULT_MESSAGE,
    executedAt: context.executedAt.toISOString(),
  });
}
