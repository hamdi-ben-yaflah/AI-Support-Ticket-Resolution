import { expect, test } from "@playwright/test";

test("resolves one synthetic ticket through the live provider path", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Ticket text").fill("I was charged twice for the same billing period.");
  await page.getByRole("button", { name: "Resolve ticket" }).click();

  await expect(page.getByText(/Supported draft ready|Human review required/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/Trace [0-9a-f-]{36}/)).toBeVisible();
});
