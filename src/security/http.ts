import "server-only";

import { z } from "zod";

import { getSecurityConfig, SecurityConfigurationError } from "@/config/security";
import type { ApiResult } from "@/domain/api-result";

export const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };
export const TICKET_BODY_BYTES = 65_536;
export const SMALL_BODY_BYTES = 1_024;
const HeaderSchema = z.object({
  contentType: z
    .string()
    .regex(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i),
  contentLength: z.string().regex(/^\d+$/).nullable(),
});

export class RequestGuardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requestGuardResponse(error: unknown, traceId: string): Response {
  const configuration = error instanceof SecurityConfigurationError;
  const known = error instanceof RequestGuardError;
  // A 408 is a stalled connection, not a malformed request: the caller may safely retry it.
  const timedOut = known && error.status === 408;
  const body: ApiResult<never> = {
    ok: false,
    traceId,
    error: {
      code: configuration
        ? "configuration_error"
        : timedOut
          ? "request_timeout"
          : "invalid_request",
      message: configuration
        ? "The request security service is not configured."
        : known
          ? error.message
          : "Request body must be valid JSON.",
      retryable: timedOut,
    },
  };
  return Response.json(body, {
    status: configuration ? 500 : known ? error.status : 400,
    headers: PRIVATE_NO_STORE,
  });
}

// Next rewrites the dev request URL to a synthetic `localhost` authority regardless of the
// interface the client reached, so outside production the Host header is the only record of
// what the browser actually addressed — and the only value its Origin can be compared against.
function addressedOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  return host ? `${new URL(request.url).protocol}//${host}` : undefined;
}

export function assertRequestOrigin(
  request: Request,
  configuredOrigin = getSecurityConfig().origin,
): void {
  const supplied = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || (supplied === null && site !== null)) {
    throw new RequestGuardError(403, "Request origin is not allowed.");
  }
  // Origin-less CLI clients remain supported. This is CSRF protection, not bot authentication.
  if (supplied === null) return;
  const expected = configuredOrigin ?? addressedOrigin(request);
  if (supplied === "null" || expected === undefined || supplied !== expected) {
    throw new RequestGuardError(403, "Request origin is not allowed.");
  }
}

export async function readGuardedJson(
  request: Request,
  maxBytes: number,
  timeoutMs = 5_000,
): Promise<unknown> {
  assertRequestOrigin(request);
  const headers = HeaderSchema.safeParse({
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
  });
  if (!headers.success)
    throw new RequestGuardError(
      415,
      "Content-Type must be application/json and headers must be valid.",
    );
  if (headers.data.contentLength !== null && Number(headers.data.contentLength) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestGuardError(413, "Request body is too large.");
  }
  if (!request.body) throw new RequestGuardError(400, "Request body must be valid JSON.");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RequestGuardError(408, "Request body read timed out.")),
      timeoutMs,
    );
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new RequestGuardError(413, "Request body is too large.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RequestGuardError) throw error;
    throw new RequestGuardError(400, "Request body must be valid JSON.");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

const LoopbackAuthoritySchema = z
  .string()
  .regex(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:[1-9]\d{0,4}))?$/i)
  .refine((value) => {
    try {
      return Number(new URL(`http://${value}`).port || 80) <= 65_535;
    } catch {
      return false;
    }
  });

export function isLoopbackHost(host: string | null): boolean {
  return LoopbackAuthoritySchema.safeParse(host).success;
}

export function isLocalEvaluationRequest(request: Request): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    isLoopbackHost(new URL(request.url).host) &&
    (request.headers.get("host") === null || isLoopbackHost(request.headers.get("host")))
  );
}
