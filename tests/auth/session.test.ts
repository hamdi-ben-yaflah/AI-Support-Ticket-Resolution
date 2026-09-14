import { describe, expect, it } from "vitest";

import {
  getOrCreateResolutionSession,
  getVerifiedSessionHash,
  hashSessionId,
  hashTicketText,
  signSessionCookie,
  verifySessionCookie,
} from "@/auth/session";
import {
  getSessionConfig,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SessionConfigurationError,
} from "@/config/session";

const secret = "test-secret-that-is-at-least-thirty-two-characters";
const config = { secret, secure: false };
const sessionId = "a".repeat(43);
const nowSeconds = 2_000_000_000;

describe("anonymous signed sessions", () => {
  it("signs, verifies, expires, and rejects tampered cookie values", () => {
    const value = signSessionCookie(sessionId, nowSeconds + 60, secret);
    expect(verifySessionCookie(value, secret, nowSeconds)).toBe(sessionId);
    expect(verifySessionCookie(value, secret, nowSeconds + 60)).toBeUndefined();
    expect(verifySessionCookie(`${value.slice(0, -1)}x`, secret, nowSeconds)).toBeUndefined();
    expect(verifySessionCookie(value.replace("v1.", "v2."), secret, nowSeconds)).toBeUndefined();
    expect(verifySessionCookie("malformed", secret, nowSeconds)).toBeUndefined();
  });

  it("creates a secure bounded HTTP-only cookie without persisting raw inputs", () => {
    const ticket = "A synthetic low-entropy ticket";
    const session = getOrCreateResolutionSession(
      new Request("http://localhost/api/tickets/resolve"),
      ticket,
      {
        config: { secret, secure: true },
        nowSeconds,
        createSessionId: () => sessionId,
      },
    );

    expect(session).toMatchObject({
      sessionHash: hashSessionId(sessionId, secret),
      ticketHash: hashTicketText(ticket, secret),
      cookie: {
        name: SESSION_COOKIE_NAME,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: true,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        },
      },
    });
    expect(JSON.stringify(session)).not.toContain(ticket);
    expect(session.sessionHash).not.toContain(sessionId);
    expect(session.ticketHash).not.toContain(ticket);
  });

  it("reuses a valid cookie and rotates an invalid one", () => {
    const validCookie = signSessionCookie(
      sessionId,
      nowSeconds + SESSION_COOKIE_MAX_AGE_SECONDS,
      secret,
    );
    const validRequest = new Request("http://localhost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${validCookie}` },
    });
    const reused = getOrCreateResolutionSession(validRequest, "A valid ticket", {
      config,
      nowSeconds,
    });
    expect(reused.cookie).toBeUndefined();
    expect(getVerifiedSessionHash(validRequest, { config, nowSeconds })).toBe(reused.sessionHash);

    const tamperedRequest = new Request("http://localhost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${validCookie.slice(0, -1)}x` },
    });
    const rotated = getOrCreateResolutionSession(tamperedRequest, "A valid ticket", {
      config,
      nowSeconds,
      createSessionId: () => "b".repeat(43),
    });
    expect(rotated.cookie).toBeDefined();
    expect(getVerifiedSessionHash(tamperedRequest, { config, nowSeconds })).toBeUndefined();
  });

  it("requires a strong server-only secret", () => {
    expect(() => getSessionConfig({ ...process.env, SESSION_COOKIE_SECRET: "short" })).toThrow(
      SessionConfigurationError,
    );
  });
});
