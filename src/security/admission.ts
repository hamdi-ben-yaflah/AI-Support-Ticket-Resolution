import "server-only";

import { getSecurityConfig } from "@/config/security";

type Limits = Pick<
  ReturnType<typeof getSecurityConfig>,
  "requestsPerMinute" | "maxConcurrent" | "sessionRequestsPerMinute"
>;
type Bucket = { count: number; expiresAt: number };
export type Admission =
  { allowed: true; release: () => void } | { allowed: false; retryAfter: number };
const WINDOW_MS = 60_000;
const MAX_SESSION_BUCKETS = 2_000;

export function createAdmissionController(options: { limits?: Limits; now?: () => number } = {}) {
  const now = options.now ?? (() => performance.now());
  let global: Bucket = { count: 0, expiresAt: 0 };
  let active = 0;
  const sessions = new Map<string, Bucket>();
  return {
    acquire(sessionHash?: string): Admission {
      const limits = options.limits ?? getSecurityConfig();
      const time = now();
      if (time >= global.expiresAt) global = { count: 0, expiresAt: time + WINDOW_MS };
      for (const [key, bucket] of sessions) if (time >= bucket.expiresAt) sessions.delete(key);
      const session = sessionHash ? sessions.get(sessionHash) : undefined;
      if (
        global.count >= limits.requestsPerMinute ||
        (session && session.count >= limits.sessionRequestsPerMinute)
      ) {
        const retryAt = Math.max(
          global.count >= limits.requestsPerMinute ? global.expiresAt : time,
          session && session.count >= limits.sessionRequestsPerMinute ? session.expiresAt : time,
        );
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((retryAt - time) / 1_000)) };
      }
      if (active >= limits.maxConcurrent) return { allowed: false, retryAfter: 1 };
      if (sessionHash && !session && sessions.size >= MAX_SESSION_BUCKETS)
        return { allowed: false, retryAfter: 60 };
      global.count++;
      active++;
      if (sessionHash)
        sessions.set(sessionHash, {
          count: (session?.count ?? 0) + 1,
          expiresAt: session?.expiresAt ?? time + WINDOW_MS,
        });
      let released = false;
      return {
        allowed: true,
        release() {
          if (!released) {
            active--;
            released = true;
          }
        },
      };
    },
  };
}
