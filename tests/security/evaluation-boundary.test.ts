import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvaluationRunHandler } from "@/app/api/evaluations/run/route";
import { createEvaluationRunsHandler } from "@/app/api/evaluations/runs/route";
import { createEvaluationCompareHandler } from "@/app/api/evaluations/compare/route";

afterEach(() => vi.unstubAllEnvs());
describe("evaluation boundary", () => {
  it.each([undefined, "false", "true"])(
    "denies every production API with flag %s before body or service work",
    async (flag) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_LIVE_EVALUATIONS", flag);
      const run = vi.fn();
      const list = vi.fn();
      const load = vi.fn();
      const request = new Request("http://localhost/api/evaluations/run", {
        method: "POST",
        body: "not json",
      });
      for (const handler of [
        createEvaluationRunHandler({ run, isEnabled: () => true }),
        createEvaluationRunsHandler({ list, isEnabled: () => true }),
        createEvaluationCompareHandler({ load, isEnabled: () => true }),
      ]) {
        const response = await handler(request);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
        expect(request.bodyUsed).toBe(false);
      }
      expect(run).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each(["http://public.example", "http://localhost.evil", "http://127.0.0.1"])(
    "rejects public URL or Host on nonproduction requests: %s",
    async (origin) => {
      const list = vi.fn();
      const response = await createEvaluationRunsHandler({ list, isEnabled: () => true })(
        new Request(`${origin}/api/evaluations/runs`, { headers: { host: "public.example" } }),
      );
      expect(response.status).toBe(404);
      expect(list).not.toHaveBeenCalled();
    },
  );
  it("rejects cross-origin local evaluation submissions", async () => {
    const run = vi.fn();
    const response = await createEvaluationRunHandler({ run, isEnabled: () => true })(
      new Request("http://localhost/api/evaluations/run", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: '{"concurrency":1}',
      }),
    );
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
});
