import { describe, expect, it } from "vitest";

import { getInvestigationToolConfig } from "@/config/investigation";

describe("investigation tool configuration", () => {
  it("uses the bounded default", () => {
    expect(getInvestigationToolConfig({ NODE_ENV: "test" })).toEqual({ timeoutMs: 3_000 });
  });

  it("accepts lower deployment values and rejects values above the hard cap", () => {
    expect(
      getInvestigationToolConfig({ NODE_ENV: "test", INVESTIGATION_TOOL_TIMEOUT_MS: "25" }),
    ).toEqual({ timeoutMs: 25 });
    expect(() =>
      getInvestigationToolConfig({
        NODE_ENV: "test",
        INVESTIGATION_TOOL_TIMEOUT_MS: "10001",
      }),
    ).toThrow("Investigation tool configuration is invalid.");
  });
});
