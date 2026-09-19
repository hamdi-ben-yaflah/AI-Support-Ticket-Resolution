import { expect, test, type Page } from "@playwright/test";

import { apiResult, createEvaluationFixtures } from "./support/evaluation-fixtures";

async function mockEvaluationApis(page: Page) {
  const fixtures = await createEvaluationFixtures();
  await page.route("**/api/evaluations/run", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(apiResult(fixtures.report)),
    });
  });
  await page.route("**/api/evaluations/runs?limit=20", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(apiResult({ runs: fixtures.summaries })),
    });
  });
  await page.route("**/api/evaluations/compare?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(apiResult(fixtures.comparison)),
    });
  });
  return fixtures;
}

test.describe("P1 evaluation lab journeys", () => {
  test("opens-local-evaluation-lab-and-loads-history", async ({ page }) => {
    await mockEvaluationApis(page);
    await page.goto("/admin/evaluations");

    await expect(page.getByText("Evaluation lab")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run controls" })).toBeVisible();
    await expect(page.getByLabel("Concurrency").locator("option")).toHaveCount(5);
    await expect(page.getByText("Recent evaluation history")).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to support desk" })).toHaveAttribute(
      "href",
      "/",
    );
    await page.getByRole("link", { name: "Return to support desk" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("runs-evaluation-and-downloads-report", async ({ page }) => {
    const fixtures = await mockEvaluationApis(page);
    await page.goto("/admin/evaluations");
    await page.getByLabel("Concurrency").selectOption("3");

    await page.getByRole("button", { name: "Run evaluation" }).click();
    await expect(page.getByText("Running 36 cases with concurrency 3")).toBeVisible();
    await expect(page.getByRole("button", { name: /running evaluation/i })).toBeDisabled();
    await expect(page.getByText("Regression detected")).toBeVisible();
    await expect(page.getByText(`Run ${fixtures.report.runId}`)).toBeVisible();
    await expect(page.getByText("P95 latency", { exact: true })).toBeVisible();
    await expect(page.getByText("Case inspection")).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON report" }).click();
    const artifact = await download;
    expect(artifact.suggestedFilename()).toBe(`evaluation-golden.v2-${fixtures.report.runId}.json`);
    expect(await artifact.createReadStream()).toBeTruthy();
  });

  test("filters-evaluation-report-to-failed-cases", async ({ page }) => {
    await mockEvaluationApis(page);
    await page.goto("/admin/evaluations");
    await page.getByRole("button", { name: "Run evaluation" }).click();
    await expect(page.getByText("Regression detected")).toBeVisible();
    await expect(page.getByText("30 of 30 cases")).toBeVisible();
    await expect(page.getByRole("button", { name: "All cases" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Failed cases" }).click();
    await expect(page.getByText("1 of 30 cases")).toBeVisible();
    await expect(page.getByRole("button", { name: "Failed cases" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("eval-case-01")).toBeVisible();
    await expect(page.getByText("eval-case-02")).not.toBeVisible();
  });

  test("compares-compatible-evaluation-runs", async ({ page }) => {
    await mockEvaluationApis(page);
    await page.goto("/admin/evaluations");

    await expect(page.getByText("Comparing saved runs…")).toBeVisible();
    await expect(page.getByText("Configuration drift may confound this comparison")).toBeVisible();
    await expect(page.getByText("+10")).toBeVisible();
    await expect(page.getByText("Case changes")).toBeVisible();

    await expect(page.getByRole("button", { name: "Regressed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Improved" }).click();
    await expect(page.getByRole("button", { name: "Improved" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "All changed" }).click();
    await expect(page.getByRole("button", { name: "All changed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "All cases" }).click();
    await expect(page.getByRole("button", { name: "All cases" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
