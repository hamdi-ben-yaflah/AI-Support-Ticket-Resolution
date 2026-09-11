import { describe, expect, it } from "vitest";

import { getResolutionPolicy } from "@/config/resolution";

describe("resolution policy configuration", () => {
  it("uses a conservative versioned default", () => {
    expect(getResolutionPolicy({ NODE_ENV: "test" })).toEqual({
      minimumConfidence: 0.65,
      version: "resolution-policy.v1",
    });
  });

  it.each(["-0.01", "1.01", "not-a-number"])(
    "rejects an invalid minimum confidence of %s",
    (minimumConfidence) => {
      expect(() =>
        getResolutionPolicy({
          NODE_ENV: "test",
          RESOLUTION_MINIMUM_CONFIDENCE: minimumConfidence,
        }),
      ).toThrow("Resolution policy configuration is invalid.");
    },
  );
});
