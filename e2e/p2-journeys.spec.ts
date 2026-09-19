import { expect, test } from "@playwright/test";

import { createApiFixtureHarness } from "./support/api-fixtures";

const firstTicket = "I was charged twice for the same billing period.";
const secondTicket = "My subscription renewal is not showing in the account.";

test.describe("P2 support desk journeys", () => {
  test("Prevents duplicate resolution submissions while a ticket is processing", async ({
    page,
  }) => {
    const fixtures = createApiFixtureHarness();
    let resolutionRequests = 0;
    await page.route("**/api/tickets/resolve", async (route) => {
      resolutionRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtures.fixtures.resolution.humanReview),
      });
    });

    await page.goto("/");
    await page.getByLabel("Ticket text").fill(firstTicket);
    const submit = page.getByRole("button", { name: "Resolve ticket" });
    await Promise.all([submit.click(), submit.click()]);
    await expect(page.getByRole("button", { name: "Resolving…" })).toBeDisabled();

    await expect(page.getByText("Human review required")).toBeVisible();
    expect(resolutionRequests).toBe(1);
  });

  test("Clears the previous proposal when the ticket text changes", async ({ page }) => {
    const fixtures = createApiFixtureHarness();
    await fixtures.routeResolution(page, fixtures.fixtures.resolution.reply);
    await page.route("**/api/sources/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtures.fixtures.source.reply),
      });
    });

    await page.goto("/");
    const input = page.getByLabel("Ticket text");
    await input.fill(firstTicket);
    await page.getByRole("button", { name: "Resolve ticket" }).click();
    await expect(page.getByText("Supported draft ready")).toBeVisible();
    await expect(page.getByText("Awaiting a ticket")).not.toBeVisible();

    await input.fill(secondTicket);
    await expect(page.getByText("Awaiting a ticket")).toBeVisible();
    await expect(page.getByText("Supported draft ready")).not.toBeVisible();
    await expect(page.getByText(firstTicket)).not.toBeVisible();
    expect(fixtures.requestCount("resolution")).toBe(1);
  });
});
