import { describe, expect, it, vi } from "vitest";

import { createSourceHandler } from "@/app/api/sources/[chunkId]/route";
import type { AppLogger } from "@/observability/logger";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
const chunkId = "223e4567-e89b-42d3-a456-426614174000";
const sessionHash = "a".repeat(64);
const source = {
  chunkId,
  sourceId: "duplicate-charges",
  title: "Duplicate charges",
  section: "When both charges settled",
  content: "Settled duplicate charges may be submitted for review.",
};

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
}

function context(value = chunkId) {
  return { params: Promise.resolve({ chunkId: value }) };
}

describe("GET /api/sources/:chunkId", () => {
  it("returns only an owned display-safe source with no-store caching", async () => {
    const findSource = vi.fn().mockResolvedValue(source);
    const response = await createSourceHandler({
      getSessionHash: () => sessionHash,
      findSource,
      createTraceId: () => traceId,
      log: logger(),
    })(new Request(`http://localhost/api/sources/${chunkId}`), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, traceId, data: source });
    expect(findSource).toHaveBeenCalledWith(sessionHash, chunkId);
  });

  it("rejects malformed identifiers before session or database access", async () => {
    const getSessionHash = vi.fn();
    const findSource = vi.fn();
    const response = await createSourceHandler({
      getSessionHash,
      findSource,
      createTraceId: () => traceId,
      log: logger(),
    })(new Request("http://localhost/api/sources/not-a-uuid"), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(getSessionHash).not.toHaveBeenCalled();
    expect(findSource).not.toHaveBeenCalled();
  });

  it.each([
    ["missing or invalid session", undefined, source],
    ["unknown or differently owned source", sessionHash, undefined],
  ])("uses the same non-revealing response for %s", async (_case, ownedSession, found) => {
    const response = await createSourceHandler({
      getSessionHash: () => ownedSession,
      findSource: vi.fn().mockResolvedValue(found),
      createTraceId: () => traceId,
      log: logger(),
    })(new Request(`http://localhost/api/sources/${chunkId}`), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      traceId,
      error: {
        code: "source_not_found",
        message: "The cited source is not available.",
        retryable: false,
      },
    });
  });

  it("maps session or database failures without exposing details", async () => {
    const response = await createSourceHandler({
      getSessionHash: () => sessionHash,
      findSource: vi.fn().mockRejectedValue(new Error("sensitive database detail")),
      createTraceId: () => traceId,
      log: logger(),
    })(new Request(`http://localhost/api/sources/${chunkId}`), context());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      traceId,
      error: { code: "source_unavailable", retryable: true },
    });
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
  });

  it("rejects source objects containing non-display fields", async () => {
    const response = await createSourceHandler({
      getSessionHash: () => sessionHash,
      findSource: vi.fn().mockResolvedValue({ ...source, embedding: [1, 2] }),
      createTraceId: () => traceId,
      log: logger(),
    })(new Request(`http://localhost/api/sources/${chunkId}`), context());

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("embedding");
  });
});
