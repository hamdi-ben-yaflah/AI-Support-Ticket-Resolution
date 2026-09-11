import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSessionHash } from "@/auth/session";
import { findOwnedSource } from "@/db/resolution-runs";
import { createApiResultSchema, type ApiResult } from "@/domain/api-result";
import { SourceDetailSchema, type SourceDetail } from "@/domain/source";
import { logger, type AppLogger } from "@/observability/logger";

const ChunkIdSchema = z.string().uuid();
const SourceApiResultSchema = createApiResultSchema(SourceDetailSchema);
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type SourceRouteContext = {
  params: Promise<{ chunkId: string }>;
};

type HandlerDependencies = {
  getSessionHash?: (request: Request) => string | undefined;
  findSource?: (sessionHash: string, chunkId: string) => Promise<SourceDetail | undefined>;
  createTraceId?: () => string;
  log?: AppLogger;
};

function response(
  status: number,
  body: ApiResult<SourceDetail>,
): NextResponse<ApiResult<SourceDetail>> {
  return NextResponse.json(SourceApiResultSchema.parse(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function notFound(traceId: string) {
  return response(404, {
    ok: false,
    traceId,
    error: {
      code: "source_not_found",
      message: "The cited source is not available.",
      retryable: false,
    },
  });
}

export function createSourceHandler(dependencies: HandlerDependencies = {}) {
  const getSessionHash = dependencies.getSessionHash ?? getVerifiedSessionHash;
  const findSource = dependencies.findSource ?? findOwnedSource;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const log = dependencies.log ?? logger;

  return async function GET(
    request: Request,
    context: SourceRouteContext,
  ): Promise<Response> {
    const traceId = createTraceId();
    const parsedChunkId = ChunkIdSchema.safeParse((await context.params).chunkId);
    if (!parsedChunkId.success) {
      log.warn({ event: "source_request_rejected", traceId, reason: "invalid_chunk_id" });
      return response(400, {
        ok: false,
        traceId,
        error: {
          code: "invalid_request",
          message: "The source identifier is invalid.",
          retryable: false,
        },
      });
    }

    try {
      const sessionHash = getSessionHash(request);
      if (!sessionHash) {
        log.warn({ event: "source_request_denied", traceId, reason: "not_owned" });
        return notFound(traceId);
      }

      const source = await findSource(sessionHash, parsedChunkId.data);
      if (!source) {
        log.warn({ event: "source_request_denied", traceId, reason: "not_owned" });
        return notFound(traceId);
      }

      log.info({ event: "source_request_completed", traceId });
      return response(200, { ok: true, traceId, data: source });
    } catch {
      log.error({ event: "source_request_failed", traceId, code: "source_unavailable" });
      return response(503, {
        ok: false,
        traceId,
        error: {
          code: "source_unavailable",
          message: "The cited source is temporarily unavailable.",
          retryable: true,
        },
      });
    }
  };
}

export const GET = createSourceHandler();
