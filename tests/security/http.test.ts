import { afterEach, describe, expect, it, vi } from "vitest";
import { getSecurityConfig } from "@/config/security";
import {
  assertRequestOrigin,
  isLoopbackHost,
  readGuardedJson,
  RequestGuardError,
  requestGuardResponse,
} from "@/security/http";

const traceId = "123e4567-e89b-42d3-a456-426614174000";
function request(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/tickets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("bounded JSON request boundary", () => {
  it("accepts Unicode and JSON with UTF-8 charset", async () => {
    const text = "語".repeat(10_000);
    await expect(
      readGuardedJson(
        request(JSON.stringify({ text }), { "content-type": "application/json; charset=UTF-8" }),
        65_536,
      ),
    ).resolves.toEqual({ text });
  });
  it.each([undefined, "1", "10000"])(
    "counts actual bytes even with Content-Length %s",
    async (length) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('"語語語"'));
        },
        cancel,
      });
      await expect(
        readGuardedJson(request(body, length ? { "content-length": length } : {}), 8),
      ).rejects.toMatchObject({ status: 413 });
      expect(cancel).toHaveBeenCalled();
    },
  );
  it("cancels a stalled read without waiting for stream cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const result = readGuardedJson(request(new ReadableStream({ cancel })), 1_024, 50);
    const assertion = expect(result).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
  it.each(["text/plain", "application/jsonp", "application/json; boundary=x"])(
    "rejects unsupported media type %s",
    async (type) => {
      await expect(
        readGuardedJson(request("{}", { "content-type": type }), 1_024),
      ).rejects.toMatchObject({ status: 415 });
    },
  );
  it("rejects invalid JSON and invalid UTF-8 without exposing input", async () => {
    for (const body of [
      "SECRET-CANARY",
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([255]));
          c.close();
        },
      }),
    ]) {
      try {
        await readGuardedJson(request(body), 1_024);
        throw new Error("Expected rejection");
      } catch (error) {
        const response = requestGuardResponse(error, traceId);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("CANARY");
      }
    }
  });
  it.each([
    [408, "request_timeout", true],
    [413, "invalid_request", false],
    [415, "invalid_request", false],
    [403, "invalid_request", false],
  ] as const)(
    "maps guard status %i to a retryability-accurate code",
    async (status, code, retryable) => {
      const response = requestGuardResponse(
        new RequestGuardError(status, "Guard rejected."),
        traceId,
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        traceId,
        error: { code, retryable },
      });
    },
  );
});

describe("origin and local-host boundaries", () => {
  it.each(["https://evil.example", "null", "http://localhost.evil.example"])(
    "rejects untrusted Origin %s",
    (origin) => {
      expect(() => assertRequestOrigin(request("{}", { origin }), "http://localhost")).toThrow(
        "origin",
      );
    },
  );
  it("compares against the addressed authority, not the framework request URL", () => {
    // Next rewrites the dev request URL to a synthetic localhost authority, so the
    // fallback has to use the host the client actually addressed.
    const addressed = (host: string, origin: string) =>
      new Request("http://localhost:3000/api/tickets/resolve", {
        method: "POST",
        headers: { "content-type": "application/json", host, origin },
      });
    expect(() =>
      assertRequestOrigin(addressed("127.0.0.1:3101", "http://127.0.0.1:3101"), undefined),
    ).not.toThrow();
    expect(() =>
      assertRequestOrigin(addressed("127.0.0.1:3101", "http://localhost:3101"), undefined),
    ).toThrow("origin");
  });
  it("accepts canonical origin and origin-less CLI, rejects browser requests without Origin", () => {
    expect(() =>
      assertRequestOrigin(
        request("{}", { origin: "https://support.example" }),
        "https://support.example",
      ),
    ).not.toThrow();
    expect(() => assertRequestOrigin(request("{}"), "https://support.example")).not.toThrow();
    expect(() =>
      assertRequestOrigin(request("{}", { "sec-fetch-site": "same-origin" }), "http://localhost"),
    ).toThrow();
    expect(() =>
      assertRequestOrigin(
        request("{}", { origin: "http://localhost", "sec-fetch-site": "cross-site" }),
        "http://localhost",
      ),
    ).toThrow();
  });
  it("requires configured production origin and ignores forwarded hosts", () => {
    expect(() => getSecurityConfig({ NODE_ENV: "production" })).toThrow();
    expect(() =>
      getSecurityConfig({ NODE_ENV: "production", APP_ORIGIN: "https://support.example/path" }),
    ).toThrow();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://support.example");
    expect(() =>
      assertRequestOrigin(
        request("{}", { origin: "https://evil.example", "x-forwarded-host": "evil.example" }),
      ),
    ).toThrow();
  });
  it.each(["localhost", "localhost:3100", "127.0.0.1:80", "[::1]:3000"])(
    "accepts loopback %s",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );
  it.each([
    null,
    "localhost.evil",
    "127.1",
    "0.0.0.0",
    "localhost:99999",
    "localhost@evil",
    "evil,localhost",
  ])("rejects non-loopback authority %s", (host) => expect(isLoopbackHost(host)).toBe(false));
});
