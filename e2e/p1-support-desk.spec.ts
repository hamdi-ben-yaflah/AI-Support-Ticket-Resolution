import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

import { createApiFixtureHarness, FIXTURE_IDS } from "./support/api-fixtures";

const ticketText = "I was charged twice for the same billing period.";

async function submitTicket(page: Page): Promise<void> {
  await page.getByLabel("Ticket text").fill(ticketText);
  await page.getByRole("button", { name: "Resolve ticket" }).click();
}

async function fulfill<T>(route: Route, body: T, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function setSession(context: BrowserContext, value: string): Promise<void> {
  await context.addCookies([
    {
      name: "support_copilot_session",
      value,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

test.describe("P1 support-desk journeys", () => {
  test("rejects-empty-ticket", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Ticket text").focus();
    await page.getByLabel("Customer tier").focus();

    await expect(page.locator('p[role="alert"]')).toHaveText(
      "Enter a ticket before classifying it.",
    );
    await expect(page.getByRole("button", { name: "Resolve ticket" })).toBeDisabled();
  });

  test("rejects-ticket-shorter-than-ten-characters", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Ticket text").fill("Too short");
    await page.getByLabel("Customer tier").focus();

    await expect(page.locator('p[role="alert"]')).toHaveText(
      "Use at least 10 characters so the ticket has enough context.",
    );
    await expect(page.getByText("9 / 10,000")).toBeVisible();
  });

  test("rejects-ticket-longer-than-ten-thousand-characters", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Ticket text").fill("x".repeat(10_001));
    await page.getByLabel("Customer tier").focus();

    await expect(page.locator('p[role="alert"]')).toHaveText(
      "Keep the ticket at or below 10,000 characters.",
    );
    await expect(page.getByText("10,001 / 10,000")).toBeVisible();
  });

  test("accepts-boundary-ticket-lengths", async ({ page }) => {
    const fixtures = createApiFixtureHarness();
    let requests = 0;
    await page.route("**/api/tickets/resolve", async (route) => {
      requests += 1;
      await fulfill(route, fixtures.fixtures.resolution.humanReview);
    });

    await page.goto("/");
    const input = page.getByLabel("Ticket text");
    await input.fill("x".repeat(10));
    await expect(page.getByRole("button", { name: "Resolve ticket" })).toBeEnabled();
    await page.getByRole("button", { name: "Resolve ticket" }).click();
    await expect(page.getByText("Human review required")).toBeVisible();

    await input.fill("x".repeat(10_000));
    await expect(page.getByRole("button", { name: "Resolve ticket" })).toBeEnabled();
    await page.getByRole("button", { name: "Resolve ticket" }).click();
    await expect(page.getByText("Human review required")).toBeVisible();
    expect(requests).toBe(2);
  });

  test("retries-after-retryable-resolution-failure", async ({ page }) => {
    const fixtures = createApiFixtureHarness();
    let attempts = 0;
    await page.route("**/api/tickets/resolve", async (route) => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fulfill(
        route,
        attempts === 1
          ? fixtures.fixtures.resolution.retryableFailure
          : fixtures.fixtures.resolution.reply,
        attempts === 1 ? 504 : 200,
      );
    });
    await fixtures.routeSource(page, fixtures.fixtures.source.reply, FIXTURE_IDS.replyChunk);

    await page.goto("/");
    await submitTicket(page);
    await expect(page.getByText("Resolution not available")).toBeVisible();
    await expect(page.getByText("The model took too long to respond.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try resolution again" })).toBeVisible();

    await page.getByRole("button", { name: "Try resolution again" }).click();
    await expect(page.getByText("Supported draft ready")).toBeVisible();
    expect(attempts).toBe(2);
  });

  test("retries-temporarily-unavailable-citation-source", async ({ page }) => {
    const fixtures = createApiFixtureHarness();
    let sourceAttempts = 0;
    await fixtures.routeResolution(page, fixtures.fixtures.resolution.reply);
    await page.route(`**/api/sources/${FIXTURE_IDS.replyChunk}`, async (route) => {
      sourceAttempts += 1;
      await fulfill(
        route,
        sourceAttempts === 1
          ? fixtures.fixtures.source.unavailable
          : fixtures.fixtures.source.reply,
        sourceAttempts === 1 ? 503 : 200,
      );
    });

    await page.goto("/");
    await submitTicket(page);
    await expect(page.getByText("The exact source could not be loaded.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry source" })).toBeVisible();

    await page.getByRole("button", { name: "Retry source" }).click();
    await expect(page.getByText("Retrieved evidence")).toBeVisible();
    await expect(
      page.getByText(
        fixtures.fixtures.source.reply.ok ? fixtures.fixtures.source.reply.data.content : "",
      ),
    ).toBeVisible();
    expect(sourceAttempts).toBe(2);
  });

  test("denies-source-access-from-another-session", async ({ browser }) => {
    const owner = await browser.newContext();
    const other = await browser.newContext();
    await setSession(owner, "session-a");
    await setSession(other, "session-b");
    await owner.route(`**/api/sources/${FIXTURE_IDS.replyChunk}`, async (route) => {
      await fulfill(route, {
        ok: true,
        traceId: FIXTURE_IDS.sourceTrace,
        data: {
          chunkId: FIXTURE_IDS.replyChunk,
          sourceId: "duplicate-charges",
          title: "Duplicate charges",
          section: "When both charges settled",
          content: "Owner-only evidence",
        },
      });
    });
    await other.route(`**/api/sources/${FIXTURE_IDS.replyChunk}`, async (route) => {
      await fulfill(
        route,
        {
          ok: false,
          traceId: FIXTURE_IDS.sourceTrace,
          error: {
            code: "source_not_found",
            message: "The cited source is not available.",
            retryable: false,
          },
        },
        404,
      );
    });

    const ownerPage = await owner.newPage();
    const otherPage = await other.newPage();
    await ownerPage.goto("/");
    await otherPage.goto("/");
    const ownerResponse = await ownerPage.evaluate(async (chunkId) => {
      const response = await fetch(`/api/sources/${chunkId}`);
      return { status: response.status, body: await response.json() };
    }, FIXTURE_IDS.replyChunk);
    expect(ownerResponse.body.ok).toBe(true);
    expect(ownerResponse.status).toBe(200);
    const otherResponse = await otherPage.evaluate(async (chunkId) => {
      const response = await fetch(`/api/sources/${chunkId}`);
      return { status: response.status, body: await response.json() };
    }, FIXTURE_IDS.replyChunk);
    expect(otherResponse.status).toBe(404);
    expect(otherResponse.body).toMatchObject({ ok: false, error: { code: "source_not_found" } });
    expect(JSON.stringify(otherResponse.body)).not.toContain("Owner-only evidence");
    await ownerPage.close();
    await otherPage.close();
    await owner.close();
    await other.close();
  });

  test("denies-refund-confirmation-from-another-session", async ({ browser }) => {
    const owner = await browser.newContext();
    const other = await browser.newContext();
    await setSession(owner, "session-a");
    await setSession(other, "session-b");
    await owner.route(
      `**/api/actions/refund-review/${FIXTURE_IDS.refundProposal}/confirm`,
      async (route) => {
        await fulfill(route, {
          ok: true,
          traceId: FIXTURE_IDS.confirmationTrace,
          data: {
            proposalId: FIXTURE_IDS.refundProposal,
            status: "mock_review_recorded",
            message: "Owner-only action result",
            executedAt: "2026-09-18T10:00:00.000Z",
          },
        });
      },
    );
    await other.route(
      `**/api/actions/refund-review/${FIXTURE_IDS.refundProposal}/confirm`,
      async (route) => {
        await fulfill(
          route,
          {
            ok: false,
            traceId: FIXTURE_IDS.confirmationTrace,
            error: {
              code: "action_not_found",
              message: "The mock refund-review proposal is not available.",
              retryable: false,
            },
          },
          404,
        );
      },
    );

    const ownerPage = await owner.newPage();
    const otherPage = await other.newPage();
    await ownerPage.goto("/");
    await otherPage.goto("/");
    const ownerResponse = await ownerPage.evaluate(async (proposalId) => {
      const response = await fetch(`/api/actions/refund-review/${proposalId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      return { status: response.status, body: await response.json() };
    }, FIXTURE_IDS.refundProposal);
    expect(ownerResponse.body.ok).toBe(true);
    expect(ownerResponse.status).toBe(200);
    const otherResponse = await otherPage.evaluate(async (proposalId) => {
      const response = await fetch(`/api/actions/refund-review/${proposalId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      return { status: response.status, body: await response.json() };
    }, FIXTURE_IDS.refundProposal);
    expect(otherResponse.status).toBe(404);
    expect(otherResponse.body).toMatchObject({ ok: false, error: { code: "action_not_found" } });
    expect(JSON.stringify(otherResponse.body)).not.toContain("Owner-only action result");
    await ownerPage.close();
    await otherPage.close();
    await owner.close();
    await other.close();
  });
});
