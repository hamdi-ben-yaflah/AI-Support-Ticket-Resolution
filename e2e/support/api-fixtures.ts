import type { Page, Route } from "@playwright/test";

import { createApiResultSchema, type ApiResult } from "@/domain/api-result";
import {
  type HumanReviewResolutionProposal,
  type RefundReviewResolutionProposal,
  type ReplyResolutionProposal,
  type ResolutionProposal,
  ResolutionProposalSchema,
} from "@/domain/grounded-reply";
import { MockRefundReviewResultSchema } from "@/domain/refund-review";
import { SourceDetailSchema, type SourceDetail } from "@/domain/source";

export const FIXTURE_IDS = {
  replyTrace: "123e4567-e89b-42d3-a456-426614174000",
  replyChunk: "223e4567-e89b-42d3-a456-426614174000",
  refundTrace: "323e4567-e89b-42d3-a456-426614174000",
  refundProposal: "423e4567-e89b-42d3-a456-426614174000",
  refundChunk: "523e4567-e89b-42d3-a456-426614174000",
  humanTrace: "623e4567-e89b-42d3-a456-426614174000",
  failureTrace: "723e4567-e89b-42d3-a456-426614174000",
  sourceTrace: "823e4567-e89b-42d3-a456-426614174000",
  confirmationTrace: "923e4567-e89b-42d3-a456-426614174000",
} as const;

export type ResolutionFixture = {
  reply: ApiResult<ReplyResolutionProposal>;
  refundReview: ApiResult<RefundReviewResolutionProposal>;
  humanReview: ApiResult<HumanReviewResolutionProposal>;
  retryableFailure: ApiResult<ReplyResolutionProposal>;
};

export type SourceFixture = {
  reply: ApiResult<SourceDetail>;
  refundReview: ApiResult<SourceDetail>;
  unavailable: ApiResult<SourceDetail>;
};

export type ConfirmationFixture = {
  success: ApiResult<Awaited<ReturnType<typeof MockRefundReviewResultSchema.parse>>>;
  unavailable: ApiResult<Awaited<ReturnType<typeof MockRefundReviewResultSchema.parse>>>;
};

export type ApiFixtures = {
  resolution: ResolutionFixture;
  source: SourceFixture;
  confirmation: ConfirmationFixture;
};

export type FixtureResponse<T> = {
  status: number;
  body: ApiResult<T>;
};

export type FixtureResponseInput<T> = ApiResult<T> | FixtureResponse<T>;

type RouteName = "resolution" | "source" | "confirmation";

type RecordedRequest = {
  method: string;
  url: string;
  body: unknown;
};

const resolutionResponse = createApiResultSchema(ResolutionProposalSchema);
const sourceResponse = createApiResultSchema(SourceDetailSchema);
const confirmationResponse = createApiResultSchema(MockRefundReviewResultSchema);

function validatedResult<T>(
  schema: ReturnType<typeof createApiResultSchema>,
  body: ApiResult<T>,
): ApiResult<T> {
  return schema.parse(body) as ApiResult<T>;
}

function fixtureResponse<T>(body: ApiResult<T>, status: number): FixtureResponse<T> {
  return { status, body };
}

function toFixtureResponse<T>(response: ApiResult<T> | FixtureResponse<T>): FixtureResponse<T> {
  if ("status" in response && "body" in response) return response;
  if (response.ok) return fixtureResponse(response, 200);

  const statusByCode: Record<string, number> = {
    provider_timeout: 504,
    source_not_found: 404,
    action_not_found: 404,
    invalid_request: 400,
  };
  return fixtureResponse(
    response,
    statusByCode[response.error.code] ?? (response.error.retryable ? 503 : 502),
  );
}

export function createApiFixtures(): ApiFixtures {
  const replyCitation = {
    chunkId: FIXTURE_IDS.replyChunk,
    sourceId: "duplicate-charges",
    section: "When both charges settled",
    claim: "Settled duplicate charges may be submitted for review.",
  };
  const refundCitation = {
    chunkId: FIXTURE_IDS.refundChunk,
    sourceId: "refund-policy",
    section: "Submitting a refund review",
    claim: "A refund review can be requested when the policy requirements are met.",
  };
  const refundReason = "The supplied billing evidence supports a refund review.";
  const refundSummary = "The customer reports a settled charge that needs refund review.";

  const reply: ApiResult<ReplyResolutionProposal> = validatedResult(resolutionResponse, {
    ok: true,
    traceId: FIXTURE_IDS.replyTrace,
    data: {
      category: "billing",
      priority: "medium",
      summary: "The customer reports a settled duplicate charge.",
      confidence: 0.94,
      action: "reply",
      reason: "The duplicate-charge policy supports a grounded draft.",
      groundedReply: {
        suggestedResponse:
          "We can review the settled duplicate charge using the billing details provided.",
        citations: [replyCitation],
      },
    },
  });

  const refundReview: ApiResult<RefundReviewResolutionProposal> = validatedResult(
    resolutionResponse,
    {
      ok: true,
      traceId: FIXTURE_IDS.refundTrace,
      data: {
        category: "billing",
        priority: "high",
        summary: refundSummary,
        confidence: 0.91,
        action: "request_refund_review",
        reason: refundReason,
        groundedReply: {
          suggestedResponse: "We can submit this charge for a refund review.",
          citations: [refundCitation],
        },
        actionProposal: {
          proposalId: FIXTURE_IDS.refundProposal,
          toolName: "requestRefundReview",
          state: "pending_confirmation",
          arguments: {
            reason: refundReason,
            ticketSummary: refundSummary,
            evidenceChunkIds: [FIXTURE_IDS.refundChunk],
          },
        },
      },
    },
  );

  const humanReview: ApiResult<HumanReviewResolutionProposal> = validatedResult(
    resolutionResponse,
    {
      ok: true,
      traceId: FIXTURE_IDS.humanTrace,
      data: {
        category: "other",
        priority: "medium",
        summary: "The ticket does not contain enough supported evidence.",
        confidence: 0.28,
        action: "needs_human_review",
        reason: "The available evidence is insufficient to recommend a supported resolution.",
      },
    },
  );

  const retryableFailure: ApiResult<ReplyResolutionProposal> = validatedResult(resolutionResponse, {
    ok: false,
    traceId: FIXTURE_IDS.failureTrace,
    error: {
      code: "provider_timeout",
      message: "The model request timed out. Try again.",
      retryable: true,
    },
  });

  const replySource: ApiResult<SourceDetail> = validatedResult(sourceResponse, {
    ok: true,
    traceId: FIXTURE_IDS.sourceTrace,
    data: {
      chunkId: FIXTURE_IDS.replyChunk,
      sourceId: "duplicate-charges",
      title: "Duplicate charges",
      section: "When both charges settled",
      content:
        "Settled duplicate charges may be submitted for review when both charges cover the same account and billing period.",
    },
  });

  const refundSource: ApiResult<SourceDetail> = validatedResult(sourceResponse, {
    ok: true,
    traceId: FIXTURE_IDS.sourceTrace,
    data: {
      chunkId: FIXTURE_IDS.refundChunk,
      sourceId: "refund-policy",
      title: "Refund policy",
      section: "Submitting a refund review",
      content: "A refund review may be requested when the required billing facts are present.",
    },
  });

  const sourceUnavailable: ApiResult<SourceDetail> = validatedResult(sourceResponse, {
    ok: false,
    traceId: FIXTURE_IDS.sourceTrace,
    error: {
      code: "source_unavailable",
      message: "The cited source is temporarily unavailable.",
      retryable: true,
    },
  });

  const confirmationSuccess: ApiResult<
    Awaited<ReturnType<typeof MockRefundReviewResultSchema.parse>>
  > = validatedResult(confirmationResponse, {
    ok: true,
    traceId: FIXTURE_IDS.confirmationTrace,
    data: {
      proposalId: FIXTURE_IDS.refundProposal,
      status: "mock_review_recorded",
      message: "A local mock review was recorded. No refund was approved or issued.",
      executedAt: "2026-09-18T10:00:00.000Z",
    },
  });

  const confirmationUnavailable: ApiResult<
    Awaited<ReturnType<typeof MockRefundReviewResultSchema.parse>>
  > = validatedResult(confirmationResponse, {
    ok: false,
    traceId: FIXTURE_IDS.confirmationTrace,
    error: {
      code: "action_unavailable",
      message: "The mock refund-review action is temporarily unavailable.",
      retryable: true,
    },
  });

  return {
    resolution: { reply, refundReview, humanReview, retryableFailure },
    source: { reply: replySource, refundReview: refundSource, unavailable: sourceUnavailable },
    confirmation: { success: confirmationSuccess, unavailable: confirmationUnavailable },
  };
}

function responseBody(response: FixtureResponse<unknown>): string {
  return JSON.stringify(response.body);
}

async function fulfill<T>(route: Route, response: FixtureResponse<T>): Promise<void> {
  await route.fulfill({
    status: response.status,
    contentType: "application/json",
    body: responseBody(response as FixtureResponse<unknown>),
  });
}

function readRequestBody(route: Route): unknown {
  const raw = route.request().postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function createApiFixtureHarness(fixtures = createApiFixtures()) {
  const requests: Record<RouteName, RecordedRequest[]> = {
    resolution: [],
    source: [],
    confirmation: [],
  };

  function record(name: RouteName, route: Route): void {
    requests[name].push({
      method: route.request().method(),
      url: route.request().url(),
      body: readRequestBody(route),
    });
  }

  return {
    fixtures,
    async routeResolution(
      page: Page,
      response: FixtureResponseInput<ResolutionProposal>,
    ): Promise<void> {
      await page.route("**/api/tickets/resolve", async (route) => {
        record("resolution", route);
        await fulfill(route, toFixtureResponse(response));
      });
    },
    async routeSource(
      page: Page,
      response: FixtureResponseInput<SourceDetail>,
      chunkId = "**",
    ): Promise<void> {
      await page.route(`**/api/sources/${chunkId}`, async (route) => {
        record("source", route);
        await fulfill(route, toFixtureResponse(response));
      });
    },
    async routeConfirmation(
      page: Page,
      response: FixtureResponseInput<
        Awaited<ReturnType<typeof MockRefundReviewResultSchema.parse>>
      >,
      proposalId = "**",
    ): Promise<void> {
      await page.route(`**/api/actions/refund-review/${proposalId}/confirm`, async (route) => {
        record("confirmation", route);
        await fulfill(route, toFixtureResponse(response));
      });
    },
    requestCount(name: RouteName): number {
      return requests[name].length;
    },
    requestBodies(name: RouteName): readonly unknown[] {
      return requests[name].map((request) => request.body);
    },
    requests(name: RouteName): readonly RecordedRequest[] {
      return requests[name];
    },
  };
}
