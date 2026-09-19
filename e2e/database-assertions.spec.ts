import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("E2E_DATABASE_URL is required for database-backed browser tests.");
}
process.env.DATABASE_URL = databaseUrl;

import { getDatabase } from "@/db/client";
import { actionAudit, resolutionRuns } from "@/db/schema";
import { hashSessionId, signSessionCookie } from "@/auth/session";
import {
  getSessionConfig,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "@/config/session";

const traceId = "a1111111-1111-4111-8111-111111111111";
const proposalId = "a2222222-2222-4222-8222-222222222222";
const chunkId = "a3333333-3333-4333-8333-333333333333";
const ownerSessionId = "owner-session-for-e2e-database";
const otherSessionId = "other-session-for-e2e-database";
const ticketHash = "b".repeat(64);
const reason = "Synthetic evidence supports a refund review.";
const summary = "Synthetic duplicate charge for database-backed browser coverage.";

function sessionCookie(sessionId: string) {
  const config = getSessionConfig();
  const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_COOKIE_MAX_AGE_SECONDS;
  return {
    name: SESSION_COOKIE_NAME,
    value: signSessionCookie(sessionId, expiresAt, config.secret),
    domain: "127.0.0.1",
    path: "/",
  };
}

async function seedAction(): Promise<void> {
  const config = getSessionConfig();
  const { persistSuccessfulResolution } = await import("@/db/resolution-runs");
  await persistSuccessfulResolution({
    traceId,
    sessionHash: hashSessionId(ownerSessionId, config.secret),
    ticketHash,
    classification: {
      category: "billing",
      priority: "high",
      summary,
      confidence: 0.91,
    },
    action: {
      type: "request_refund_review",
      reason,
      proposal: {
        proposalId,
        toolName: "requestRefundReview",
        state: "pending_confirmation",
        arguments: { reason, ticketSummary: summary, evidenceChunkIds: [chunkId] },
      },
    },
    citedSources: [
      {
        citationPosition: 0,
        chunkId,
        sourceId: "e2e-database-source",
        title: "Synthetic database evidence",
        section: "Database assertions",
        content: "Synthetic evidence for ownership and idempotency assertions.",
      },
    ],
    metadata: {
      promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
      resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
      provider: "e2e-fixture",
      model: "e2e-fixture",
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      retryCount: 0,
      validationPassed: true,
    },
  });
}

async function cleanup(): Promise<void> {
  const db = getDatabase();
  await db.delete(resolutionRuns).where(eq(resolutionRuns.traceId, traceId));
}

test.beforeAll(async () => {
  await cleanup();
  await seedAction();
});

test.afterAll(cleanup);

test("Rejects source access and refund confirmation from a different session", async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const other = await browser.newContext();
  await owner.addCookies([sessionCookie(ownerSessionId)]);
  await other.addCookies([sessionCookie(otherSessionId)]);

  const ownerPage = await owner.newPage();
  const otherPage = await other.newPage();
  await ownerPage.goto("/");
  await otherPage.goto("/");

  const ownerSource = await ownerPage.evaluate(async (id) => {
    const response = await fetch(`/api/sources/${id}`);
    return { status: response.status, body: (await response.json()) as unknown };
  }, chunkId);
  const otherSource = await otherPage.evaluate(async (id) => {
    const response = await fetch(`/api/sources/${id}`);
    return { status: response.status, body: (await response.json()) as unknown };
  }, chunkId);
  expect(ownerSource.status).toBe(200);
  expect(otherSource.status).toBe(404);

  const otherConfirmation = await otherPage.evaluate(async (id) => {
    const response = await fetch(`/api/actions/refund-review/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }, proposalId);
  expect(otherConfirmation.status).toBe(404);
  expect(JSON.stringify(otherConfirmation.body)).not.toContain(reason);

  await ownerPage.close();
  await otherPage.close();
  await owner.close();
  await other.close();
});

test("Persists one audit result when refund confirmation is repeated", async ({ browser }) => {
  const owner = await browser.newContext();
  await owner.addCookies([sessionCookie(ownerSessionId)]);
  const page = await owner.newPage();
  await page.goto("/");

  const confirm = () =>
    page.evaluate(async (id) => {
      const response = await fetch(`/api/actions/refund-review/${id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      return { status: response.status, body: (await response.json()) as { data?: unknown } };
    }, proposalId);

  const [first, second] = await Promise.all([confirm(), confirm()]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.data).toEqual(second.body.data);

  const rows = await getDatabase()
    .select({ proposalId: actionAudit.proposalId, state: actionAudit.state })
    .from(actionAudit)
    .where(eq(actionAudit.proposalId, proposalId));
  expect(rows).toEqual([{ proposalId, state: "executed" }]);

  await page.close();
  await owner.close();
});
