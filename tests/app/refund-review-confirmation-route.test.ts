import { describe, expect, it, vi } from "vitest";

import { createRefundReviewConfirmationHandler } from "@/app/api/actions/refund-review/[proposalId]/confirm/route";
import { ActionAuditRepositoryError } from "@/db/action-audit";
import type { AppLogger } from "@/observability/logger";

const proposalId = "223e4567-e89b-42d3-a456-426614174000";
const traceId = "123e4567-e89b-42d3-a456-426614174000";
const sessionHash = "a".repeat(64);
const result = {
  proposalId,
  status: "mock_review_recorded" as const,
  message: "A local mock record was created. No refund was approved or issued.",
  executedAt: "2026-09-12T10:00:00.000Z",
};

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger;
}

function request(body: string, cookie = "support_copilot_session=signed-secret") {
  return new Request(`http://localhost/api/actions/refund-review/${proposalId}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body,
  });
}

function context(id = proposalId) {
  return { params: Promise.resolve({ proposalId: id }) };
}

describe("POST /api/actions/refund-review/:proposalId/confirm", () => {
  it("requires exact explicit confirmation before invoking the action service", async () => {
    for (const body of ["{", "{}", '{"confirmed":false}', '{"confirmed":true,"force":true}']) {
      const confirm = vi.fn();
      const response = await createRefundReviewConfirmationHandler({
        confirm,
        getSessionHash: () => sessionHash,
        createTraceId: () => traceId,
        log: logger(),
      })(request(body), context());
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(confirm).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed proposal IDs before session or execution checks", async () => {
    const confirm = vi.fn();
    const getSessionHash = vi.fn();
    const response = await createRefundReviewConfirmationHandler({
      confirm,
      getSessionHash,
      createTraceId: () => traceId,
      log: logger(),
    })(request('{"confirmed":true}'), context("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
    expect(getSessionHash).not.toHaveBeenCalled();
  });

  it("returns the same non-revealing absence for missing and non-owning sessions", async () => {
    const missingConfirm = vi.fn();
    const missing = await createRefundReviewConfirmationHandler({
      confirm: missingConfirm,
      getSessionHash: () => undefined,
      createTraceId: () => traceId,
      log: logger(),
    })(request('{"confirmed":true}'), context());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "action_not_found", retryable: false },
    });
    expect(missingConfirm).not.toHaveBeenCalled();

    const denied = await createRefundReviewConfirmationHandler({
      confirm: vi.fn().mockRejectedValue(new ActionAuditRepositoryError("not_found")),
      getSessionHash: () => sessionHash,
      createTraceId: () => traceId,
      log: logger(),
    })(request('{"confirmed":true}'), context());
    expect(denied.status).toBe(404);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "action_not_found" },
    });
  });

  it("returns the immutable mock result on first and repeated confirmations", async () => {
    const confirm = vi.fn().mockResolvedValue(result);
    const handler = createRefundReviewConfirmationHandler({
      confirm,
      getSessionHash: () => sessionHash,
      createTraceId: () => traceId,
      log: logger(),
    });
    const first = await handler(request('{"confirmed":true}'), context());
    const repeated = await handler(request('{"confirmed":true}'), context());

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({ ok: true, traceId, data: result });
    expect(await repeated.json()).toEqual({ ok: true, traceId, data: result });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith({ proposalId, sessionHash, traceId });
  });

  it("maps storage, stored-data, and malformed service results to retryable unavailability", async () => {
    for (const failure of [
      () => Promise.reject(new Error("sensitive database detail")),
      () => Promise.resolve({ ...result, status: "refund_issued" }),
    ]) {
      const log = logger();
      const response = await createRefundReviewConfirmationHandler({
        confirm: vi.fn().mockImplementation(failure),
        getSessionHash: () => sessionHash,
        createTraceId: () => traceId,
        log,
      })(request('{"confirmed":true}'), context());
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: { code: "action_unavailable", retryable: true },
      });
      expect(JSON.stringify(body)).not.toContain("sensitive database detail");
      expect(
        JSON.stringify({
          info: vi.mocked(log.info).mock.calls,
          warn: vi.mocked(log.warn).mock.calls,
          error: vi.mocked(log.error).mock.calls,
        }),
      ).not.toContain("signed-secret");
    }
  });
});
