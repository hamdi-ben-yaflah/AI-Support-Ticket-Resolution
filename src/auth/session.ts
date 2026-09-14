import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  getSessionConfig,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  type SessionConfig,
} from "@/config/session";

const COOKIE_VERSION = "v1";
const SESSION_ID_BYTES = 32;
const SHA_256_HEX_LENGTH = 64;

export type SessionCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    path: "/";
    maxAge: number;
    secure: boolean;
  };
};

export type ResolutionSession = {
  sessionHash: string;
  ticketHash: string;
  cookie?: SessionCookie;
};

function digest(secret: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest();
}

function signature(secret: string, payload: string): string {
  return digest(secret, "cookie-signature", payload).toString("base64url");
}

function parseCookieHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }

  return undefined;
}

export function signSessionCookie(
  sessionId: string,
  expiresAtSeconds: number,
  secret: string,
): string {
  const payload = `${COOKIE_VERSION}.${sessionId}.${expiresAtSeconds}`;
  return `${payload}.${signature(secret, payload)}`;
}

export function verifySessionCookie(
  value: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string | undefined {
  if (!value) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;

  const [version, sessionId, rawExpiry, suppliedSignature] = parts;
  if (
    version !== COOKIE_VERSION ||
    !sessionId ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionId) ||
    !rawExpiry ||
    !/^\d{10}$/.test(rawExpiry) ||
    !suppliedSignature ||
    !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) {
    return undefined;
  }

  const expiresAtSeconds = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= nowSeconds) {
    return undefined;
  }

  const payload = `${version}.${sessionId}.${rawExpiry}`;
  const expected = Buffer.from(signature(secret, payload), "base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }

  return sessionId;
}

export function hashSessionId(sessionId: string, secret: string): string {
  const value = digest(secret, "session-hash", sessionId).toString("hex");
  if (value.length !== SHA_256_HEX_LENGTH) throw new Error("Unexpected session hash length.");
  return value;
}

export function hashTicketText(ticketText: string, secret: string): string {
  const value = digest(secret, "ticket-hash", ticketText).toString("hex");
  if (value.length !== SHA_256_HEX_LENGTH) throw new Error("Unexpected ticket hash length.");
  return value;
}

function sessionCookie(value: string, secure: boolean): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value,
    options: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      secure,
    },
  };
}

export function getOrCreateResolutionSession(
  request: Request,
  ticketText: string,
  options: {
    config?: SessionConfig;
    nowSeconds?: number;
    createSessionId?: () => string;
  } = {},
): ResolutionSession {
  const config = options.config ?? getSessionConfig();
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const existingValue = parseCookieHeader(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  const existingId = verifySessionCookie(existingValue, config.secret, nowSeconds);
  const sessionId =
    existingId ??
    (options.createSessionId ?? (() => randomBytes(SESSION_ID_BYTES).toString("base64url")))();

  return {
    sessionHash: hashSessionId(sessionId, config.secret),
    ticketHash: hashTicketText(ticketText, config.secret),
    ...(!existingId
      ? {
          cookie: sessionCookie(
            signSessionCookie(
              sessionId,
              nowSeconds + SESSION_COOKIE_MAX_AGE_SECONDS,
              config.secret,
            ),
            config.secure,
          ),
        }
      : {}),
  };
}

export function getVerifiedSessionHash(
  request: Request,
  options: { config?: SessionConfig; nowSeconds?: number } = {},
): string | undefined {
  const config = options.config ?? getSessionConfig();
  const value = parseCookieHeader(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  const sessionId = verifySessionCookie(value, config.secret, options.nowSeconds);
  return sessionId ? hashSessionId(sessionId, config.secret) : undefined;
}
