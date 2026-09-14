import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("@/db/client", () => ({
  getDatabase: () => ({ execute }),
}));

import { checkDatabaseReadiness } from "@/db/readiness";

describe("database readiness", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("resolves after a successful bounded probe", async () => {
    execute.mockResolvedValue(undefined);
    await expect(checkDatabaseReadiness(100)).resolves.toBeUndefined();
  });

  it("propagates probe failures without rewriting database details", async () => {
    const failure = new Error("database unavailable");
    execute.mockRejectedValue(failure);
    await expect(checkDatabaseReadiness(100)).rejects.toBe(failure);
  });

  it("rejects a probe that exceeds its deadline", async () => {
    execute.mockReturnValue(new Promise(() => undefined));
    await expect(checkDatabaseReadiness(1)).rejects.toThrow("Database readiness timed out.");
  });
});
