import { describe, expect, it, vi } from "vitest";
import { createResolveHandler } from "@/app/api/tickets/resolve/route";
import { createRefundReviewConfirmationHandler } from "@/app/api/actions/refund-review/[proposalId]/confirm/route";

const proposalId = "223e4567-e89b-42d3-a456-426614174000";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
});
