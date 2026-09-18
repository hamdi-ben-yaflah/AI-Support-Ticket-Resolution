import { expect, test, type Page, type Route } from "@playwright/test";

import { createApiFixtureHarness, FIXTURE_IDS } from "./support/api-fixtures";

const ticketText = "I was charged twice for the same billing period.";

function responseBody<T>(body: T): string {
  return JSON.stringify(body);
}

async function fulfillAfter<T>(route: Route, body: T, delayMs = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: responseBody(body),
  });
}

async function submitTicket(page: Page, tier: "standard" | "premium" = "standard"): Promise<void> {
  await page.getByLabel("Ticket text").fill(ticketText);
  await page.getByLabel("Customer tier").selectOption(tier);
  await page.getByRole("button", { name: "Resolve ticket" }).click();
}

test("resolve-ticket-displays-grounded-draft-and-citations", async ({ page }) => {
  const fixtures = createApiFixtureHarness();
  const resolutionRequests: unknown[] = [];

  await page.route("**/api/tickets/resolve", async (route) => {
    resolutionRequests.push(JSON.parse(route.request().postData() ?? "null"));
    await fulfillAfter(route, fixtures.fixtures.resolution.reply);
  });
  await fixtures.routeSource(page, fixtures.fixtures.source.reply, FIXTURE_IDS.replyChunk);

  await page.goto("/");
  await expect(page.getByText("Awaiting a ticket")).toBeVisible();
  await submitTicket(page, "premium");
  await expect(page.getByRole("button", { name: "Resolving…" })).toBeDisabled();
  await expect(page.getByText("Resolving the ticket…")).toBeVisible();

  await expect(page.getByText("Supported draft ready")).toBeVisible();
  await expect(page.getByText("billing", { exact: true })).toBeVisible();
  await expect(page.getByText("medium", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      fixtures.fixtures.resolution.reply.ok ? fixtures.fixtures.resolution.reply.data.summary : "",
    ),
  ).toBeVisible();
  await expect(page.getByText("94% confidence signal")).toBeVisible();
  await expect(
    page.getByText(
      "We can review the settled duplicate charge using the billing details provided.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Draft · not sent")).toBeVisible();
  await expect(page.getByText(`Trace ${FIXTURE_IDS.replyTrace}`)).toBeVisible();

  await expect(page.getByText("Duplicate charges", { exact: true })).toBeVisible();
  await expect(page.getByText("duplicate-charges")).toBeVisible();
  await expect(page.getByText("When both charges settled")).toBeVisible();
  await expect(page.getByText("Retrieved evidence")).toBeVisible();
  await expect(
    page.getByText(
      "Settled duplicate charges may be submitted for review when both charges cover the same account and billing period.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Generated support claim")).toBeVisible();
  await expect(
    page.getByText("Settled duplicate charges may be submitted for review."),
  ).toBeVisible();

  expect(resolutionRequests).toEqual([{ text: ticketText, customerTier: "premium" }]);
  expect(fixtures.requestCount("resolution")).toBe(0);
  expect(fixtures.requestCount("source")).toBe(1);
  expect(fixtures.requests("source")[0]?.url).toContain(FIXTURE_IDS.replyChunk);
});

test("abstains-with-human-review-when-evidence-is-insufficient", async ({ page }) => {
  const fixtures = createApiFixtureHarness();
  await fixtures.routeResolution(page, fixtures.fixtures.resolution.humanReview);
  await page.route("**/api/sources/**", async () => {
    throw new Error("An abstention must not request a source.");
  });

  await page.goto("/");
  await submitTicket(page);

  await expect(page.getByText("Insufficient evidence warning")).toBeVisible();
  await expect(page.getByText("Human review required")).toBeVisible();
  await expect(page.getByText("other", { exact: true })).toBeVisible();
  await expect(page.getByText("medium", { exact: true })).toBeVisible();
  await expect(
    page.getByText("The ticket does not contain enough supported evidence."),
  ).toBeVisible();
  await expect(page.getByText("28% confidence signal")).toBeVisible();
  await expect(
    page.getByText("The available evidence is insufficient to recommend a supported resolution."),
  ).toBeVisible();
  await expect(page.getByText("Review the ticket and supporting policy manually.")).toBeVisible();
  await expect(page.getByText(`Trace ${FIXTURE_IDS.humanTrace}`)).toBeVisible();

  await expect(page.getByText("Proposed reply", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Knowledge citations", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm mock review" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Reject proposal" })).not.toBeVisible();
  expect(fixtures.requestCount("resolution")).toBe(1);
});

test("rejects-refund-review-without-confirmation", async ({ page }) => {
  const fixtures = createApiFixtureHarness();
  await fixtures.routeResolution(page, fixtures.fixtures.resolution.refundReview);
  await fixtures.routeSource(page, fixtures.fixtures.source.refundReview, FIXTURE_IDS.refundChunk);
  await fixtures.routeConfirmation(
    page,
    fixtures.fixtures.confirmation.success,
    FIXTURE_IDS.refundProposal,
  );

  await page.goto("/");
  await submitTicket(page);

  await expect(page.getByText("requestRefundReview")).toBeVisible();
  await expect(
    page
      .getByText(
        fixtures.fixtures.resolution.refundReview.ok
          ? fixtures.fixtures.resolution.refundReview.data.reason
          : "",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByText(
        fixtures.fixtures.resolution.refundReview.ok
          ? fixtures.fixtures.resolution.refundReview.data.summary
          : "",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText(FIXTURE_IDS.refundChunk)).toBeVisible();
  await expect(page.getByText(`Proposal ${FIXTURE_IDS.refundProposal}`)).toBeVisible();
  await expect(page.getByText("Confirmation creates only a local audit result.")).toBeVisible();

  await page.getByRole("button", { name: "Reject proposal" }).click();
  await expect(page.getByText("rejected · not executed")).toBeVisible();
  await expect(page.getByText("Proposal rejected locally.")).toBeVisible();
  await expect(
    page.getByText("No confirmation request was sent and no mock action was executed."),
  ).toBeVisible();
  await expect(page.getByText("Local mock review recorded")).not.toBeVisible();
  expect(fixtures.requestCount("confirmation")).toBe(0);
});

test("confirms-refund-review-and-records-local-mock-result", async ({ page }) => {
  const fixtures = createApiFixtureHarness();
  const confirmationBodies: unknown[] = [];
  await fixtures.routeResolution(page, fixtures.fixtures.resolution.refundReview);
  await fixtures.routeSource(page, fixtures.fixtures.source.refundReview, FIXTURE_IDS.refundChunk);
  await page.route(
    `**/api/actions/refund-review/${FIXTURE_IDS.refundProposal}/confirm`,
    async (route) => {
      confirmationBodies.push(JSON.parse(route.request().postData() ?? "null"));
      await fulfillAfter(route, fixtures.fixtures.confirmation.success);
    },
  );

  await page.goto("/");
  await submitTicket(page);
  await expect(page.getByRole("button", { name: "Confirm mock review" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm mock review" }).click();
  await expect(page.getByRole("button", { name: "Recording mock review…" })).toBeDisabled();

  await expect(page.getByText("executed · local mock only")).toBeVisible();
  await expect(page.getByText("Local mock review recorded")).toBeVisible();
  await expect(
    page.getByText("A local mock review was recorded. No refund was approved or issued."),
  ).toBeVisible();
  await expect(page.getByText("Executed 2026-09-18T10:00:00.000Z")).toBeVisible();
  await expect(page.getByText(`Trace ${FIXTURE_IDS.confirmationTrace}`)).toBeVisible();
  await expect(page.getByText(/no refund was approved or issued/i)).toBeVisible();
  expect(confirmationBodies).toEqual([{ confirmed: true }]);
});

test("repeated-refund-confirmation-is-idempotent", async ({ page }) => {
  const fixtures = createApiFixtureHarness();
  const confirmationBodies: unknown[] = [];
  await fixtures.routeResolution(page, fixtures.fixtures.resolution.refundReview);
  await fixtures.routeSource(page, fixtures.fixtures.source.refundReview, FIXTURE_IDS.refundChunk);
  await page.route(
    `**/api/actions/refund-review/${FIXTURE_IDS.refundProposal}/confirm`,
    async (route) => {
      confirmationBodies.push(JSON.parse(route.request().postData() ?? "null"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: responseBody(fixtures.fixtures.confirmation.success),
      });
    },
  );

  await page.goto("/");
  await submitTicket(page);
  await page.getByRole("button", { name: "Confirm mock review" }).click();
  await expect(page.getByText("Local mock review recorded")).toBeVisible();

  const resultMessage = page.getByText(
    "A local mock review was recorded. No refund was approved or issued.",
  );
  await expect(resultMessage).toHaveCount(1);
  await page.getByRole("button", { name: "Confirm again (idempotent)" }).click();
  await expect(page.getByText("executed · local mock only")).toBeVisible();
  await expect(resultMessage).toHaveCount(1);
  await expect(page.getByText(`Proposal ${FIXTURE_IDS.refundProposal}`)).toHaveCount(1);
  expect(confirmationBodies).toEqual([{ confirmed: true }, { confirmed: true }]);
});
