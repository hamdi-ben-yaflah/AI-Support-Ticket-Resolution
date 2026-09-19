import { describe, expect, it, vi } from "vitest";
import { createResolveHandler } from "@/app/api/tickets/resolve/route";
import { createRefundReviewConfirmationHandler } from "@/app/api/actions/refund-review/[proposalId]/confirm/route";
import { createAdmissionController } from "@/security/admission";

const proposalId = "223e4567-e89b-42d3-a456-426614174000";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const session = { sessionHash: "a".repeat(64), ticketHash: "b".repeat(64) };
function request(body = '{"text":"Synthetic ticket"}', headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/tickets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("route security ordering", () => {
  it.each([
    ["{}", { origin: "https://evil.example" }, 403],
    ["{}", { "content-type": "text/plain" }, 415],
    ["x".repeat(65_537), {}, 413],
    ['{"text":"Synthetic ticket", "extra":"secret"}', {}, 400],
  ] as const)(
    "rejects hostile request before resolver or persistence",
    async (body, headers, status) => {
      const resolve = vi.fn();
      const persist = vi.fn();
      const createSession = vi.fn();
      const response = await createResolveHandler({ resolve, persist, createSession, log })(
        request(body, headers),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(resolve).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["{}", { origin: "https://evil.example" }, 403],
    ["{}", { "content-type": "text/plain" }, 415],
    ["x".repeat(1_025), {}, 413],
  ] as const)("rejects hostile confirmation before execution", async (body, headers, status) => {
    const confirm = vi.fn();
    const getSessionHash = vi.fn();
    const response = await createRefundReviewConfirmationHandler({ confirm, getSessionHash, log })(
      request(body, headers),
      { params: Promise.resolve({ proposalId }) },
    );
    expect(response.status).toBe(status);
    expect(confirm).not.toHaveBeenCalled();
    expect(getSessionHash).not.toHaveBeenCalled();
  });
  it("returns Retry-After without provider work, and releases permits after errors", async () => {
    const admission = createAdmissionController({
      limits: { requestsPerMinute: 2, maxConcurrent: 1, sessionRequestsPerMinute: 2 },
    });
    let reject!: (error: Error) => void;
    const resolve = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockRejectedValue(new Error("SYNTHETIC-SECRET"));
    const handler = createResolveHandler({ admission, resolve, createSession: () => session, log });
    const first = handler(request());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    const overlapping = await handler(request());
    expect(overlapping.status).toBe(429);
    expect(overlapping.headers.get("retry-after")).toBe("1");
    expect(resolve).toHaveBeenCalledTimes(1);
    reject(new Error("SYNTHETIC-SECRET"));
    expect((await first).status).toBe(500);
    expect((await handler(request())).status).toBe(500);
    const limited = await handler(request());
    expect(limited.status).toBe(429);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("SYNTHETIC-SECRET");
  });
});
