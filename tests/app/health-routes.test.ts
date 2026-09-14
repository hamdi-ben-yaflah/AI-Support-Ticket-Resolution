import { describe, expect, it, vi } from "vitest";

import { createLiveHandler } from "@/app/api/health/live/route";
import { createReadyHandler } from "@/app/api/health/ready/route";

describe("health routes", () => {
  it("returns dependency-free liveness with the safe build version", async () => {
    const response = createLiveHandler(() => "0123456789abcdef")();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      version: "0123456789abcdef",
    });
  });

  it("returns readiness only after the database check succeeds", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const response = await createReadyHandler(check)();

    expect(check).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("maps database failures to a non-revealing unavailable response", async () => {
    const response = await createReadyHandler(
      vi.fn().mockRejectedValue(new Error("postgresql://user:secret@database/internal")),
    )();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"unavailable"}');
  });
});
