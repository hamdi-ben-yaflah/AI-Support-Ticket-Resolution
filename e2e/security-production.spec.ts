import { expect, test } from "@playwright/test";
import { createApiFixtureHarness, FIXTURE_IDS } from "./support/api-fixtures";

test("production CSP has fresh nonces, security headers, working hydration and inert generated text", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const violations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/content security policy|refused to/i.test(message.text())) violations.push(message.text());
  });
  const fixtures = createApiFixtureHarness();
  const hostile =
    '<img src="https://exfil.invalid/leak" onerror="alert(1)"> [upload secrets](https://exfil.invalid)';
  const reply = fixtures.fixtures.resolution.reply;
  const source = fixtures.fixtures.source.reply;
  if (!reply.ok || !source.ok) throw new Error("Expected successful fixture");
  reply.data.groundedReply.suggestedResponse = hostile;
  source.data.content = hostile;
  await fixtures.routeResolution(page, reply);
  await fixtures.routeSource(page, source, FIXTURE_IDS.replyChunk);
  let exfiltrationRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("exfil.invalid")) exfiltrationRequests++;
  });
  const response = await page.goto("/");
  const headers = response?.headers();
  const csp = headers?.["content-security-policy"] ?? "";
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(headers?.["x-content-type-options"]).toBe("nosniff");
  expect(headers?.["x-frame-options"]).toBe("DENY");
  expect(headers?.["referrer-policy"]).toBe("no-referrer");
  expect(headers?.["permissions-policy"]).toContain("camera=()");
  expect(headers?.["cache-control"]).toContain("no-store");
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  const scriptNonces = await page
    .locator("script")
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce));
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(scriptNonces.every((value) => value === nonce)).toBe(true);
  await page.getByLabel("Ticket text").fill("Synthetic duplicate billing charge.");
  await page.getByRole("button", { name: "Resolve ticket" }).click();
  await expect(page.getByText(hostile, { exact: true })).toHaveCount(2);
  expect(await page.locator('img[src*="exfil.invalid"], a[href*="exfil.invalid"]').count()).toBe(0);
  expect(exfiltrationRequests).toBe(0);
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
  expect(
    await page.locator("main").evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  const second = await request.get("/", { headers: { "x-nonce": "attacker" } });
  const secondCsp = second.headers()["content-security-policy"];
  expect(secondCsp).not.toContain(`'nonce-${nonce}'`);
  expect(secondCsp).not.toContain("attacker");
});

test("production evaluation surfaces stay disabled with explicit enable flag", async ({
  request,
}) => {
  for (const path of ["/admin/evaluations", "/api/evaluations/runs", "/api/evaluations/compare"]) {
    expect((await request.get(path)).status()).toBe(404);
  }
  expect((await request.post("/api/evaluations/run", { data: { concurrency: 1 } })).status()).toBe(
    404,
  );
});

test("production POST guards reject hostile requests without providers", async ({ request }) => {
  const paths = [
    "/api/tickets/resolve",
    `/api/actions/refund-review/${FIXTURE_IDS.refundProposal}/confirm`,
  ];
  for (const path of paths) {
    const wrongOrigin = await request.post(path, {
      data: {},
      headers: { origin: "https://evil.example" },
    });
    expect(wrongOrigin.status()).toBe(403);
    expect(wrongOrigin.headers()["cache-control"]).toBe("private, no-store");
    const wrongType = await request.post(path, {
      data: "{}",
      headers: { "content-type": "text/plain" },
    });
    expect(wrongType.status()).toBe(415);
    const large = await request.post(path, {
      data: JSON.stringify({ text: "x".repeat(65_537) }),
      headers: { "content-type": "application/json" },
    });
    expect(large.status()).toBe(413);
  }
});
