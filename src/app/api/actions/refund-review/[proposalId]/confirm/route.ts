import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSessionHash } from "@/auth/session";
import {
  ActionAuditRepositoryError,
  confirmOwnedRefundReview,
} from "@/db/action-audit";
import { createApiResultSchema, type ApiResult } from "@/domain/api-result";
import {
  MockRefundReviewResultSchema,
  RefundReviewConfirmationSchema,
  type MockRefundReviewResult,
} from "@/domain/refund-review";
import { logger, type AppLogger } from "@/observability/logger";

const ProposalIdSchema = z.string().uuid();
const ConfirmationResultSchema = createApiResultSchema(
  MockRefundReviewResultSchema,
);
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type ConfirmationRouteContext = {
  params: Promise<{ proposalId: string }>;
};

type ConfirmationService = (input: {
  proposalId: string;
  sessionHash: string;
  traceId: string;
}) => Promise<MockRefundReviewResult>;

type HandlerDependencies = {
  getSessionHash?: (request: Request) => string | undefined;
  confirm?: ConfirmationService;
  createTraceId?: () => string;
  log?: AppLogger;
};

function response(
  status: number,
  body: ApiResult<MockRefundReviewResult>,
): NextResponse<ApiResult<MockRefundReviewResult>> {
  return NextResponse.json(ConfirmationResultSchema.parse(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function invalidRequest(traceId: string, message: string) {
  return response(400, {
    ok: false,
    traceId,
    error: { code: "invalid_request", message, retryable: false },
  });
}

function notFound(traceId: string) {
  return response(404, {
    ok: false,
    traceId,
    error: {
      code: "action_not_found",
      message: "The mock refund-review proposal is not available.",
      retryable: false,
    },
  });
}

function unavailable(traceId: string) {
  return response(503, {
    ok: false,
    traceId,
    error: {
      code: "action_unavailable",
      message: "The mock refund-review action is temporarily unavailable.",
      retryable: true,
    },
  });
}

export function createRefundReviewConfirmationHandler(
  dependencies: HandlerDependencies = {},
) {
  const getSessionHash =
    dependencies.getSessionHash ?? getVerifiedSessionHash;
  const confirm = dependencies.confirm ?? confirmOwnedRefundReview;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const log = dependencies.log ?? logger;

  return async function POST(
    request: Request,
    context: ConfirmationRouteContext,
  ): Promise<Response> {
    const traceId = createTraceId();
    const proposalId = ProposalIdSchema.safeParse(
      (await context.params).proposalId,
    );
    if (!proposalId.success) {
      log.warn({
        event: "refund_review_confirmation_rejected",
        traceId,
        reason: "invalid_proposal_id",
      });
      return invalidRequest(traceId, "The proposal identifier is invalid.");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      log.warn({
        event: "refund_review_confirmation_rejected",
        traceId,
        proposalId: proposalId.data,
        reason: "malformed_json",
      });
      return invalidRequest(traceId, "Request body must be valid JSON.");
    }
    if (!RefundReviewConfirmationSchema.safeParse(body).success) {
      log.warn({
        event: "refund_review_confirmation_rejected",
        traceId,
        proposalId: proposalId.data,
        reason: "confirmation_required",
      });
      return invalidRequest(
        traceId,
        "Explicit confirmation is required for this mock action.",
      );
    }

    try {
      const sessionHash = getSessionHash(request);
      if (!sessionHash) {
        log.warn({
          event: "refund_review_confirmation_denied",
          traceId,
          proposalId: proposalId.data,
          reason: "not_owned",
        });
        return notFound(traceId);
      }

      const result = MockRefundReviewResultSchema.parse(
        await confirm({
          proposalId: proposalId.data,
          sessionHash,
          traceId,
        }),
      );
      log.info({
        event: "refund_review_confirmation_completed",
        traceId,
        proposalId: proposalId.data,
        state: "executed",
      });
      return response(200, { ok: true, traceId, data: result });
    } catch (error) {
      if (
        error instanceof ActionAuditRepositoryError &&
        error.code === "not_found"
      ) {
        log.warn({
          event: "refund_review_confirmation_denied",
          traceId,
          proposalId: proposalId.data,
          reason: "not_owned",
        });
        return notFound(traceId);
      }
      log.error({
        event: "refund_review_confirmation_failed",
        traceId,
        proposalId: proposalId.data,
        code: "action_unavailable",
      });
      return unavailable(traceId);
    }
  };
}

export const POST = createRefundReviewConfirmationHandler();
