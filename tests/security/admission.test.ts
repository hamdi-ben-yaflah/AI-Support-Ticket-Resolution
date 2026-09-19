import { describe, expect, it } from "vitest";
import { createAdmissionController } from "@/security/admission";
const limits = { requestsPerMinute: 20, maxConcurrent: 2, sessionRequestsPerMinute: 5 };

describe("paid resolution admission", () => {
  it("enforces concurrency and releases permits exactly once", () => {
    const controller = createAdmissionController({ limits });
    const first = controller.acquire();
    const second = controller.acquire();
    expect(controller.acquire()).toEqual({ allowed: false, retryAfter: 1 });
    if (first.allowed) {
      first.release();
      first.release();
    }
    const third = controller.acquire();
    expect(third.allowed).toBe(true);
    expect(controller.acquire().allowed).toBe(false);
    if (second.allowed) second.release();
  });
  it("limits verified sessions and retains a global limit across cookie rotation", () => {
    let now = 0;
    const controller = createAdmissionController({ limits, now: () => now });
    for (let i = 0; i < 5; i++) {
      const p = controller.acquire("same");
      expect(p.allowed).toBe(true);
      if (p.allowed) p.release();
    }
    expect(controller.acquire("same")).toEqual({ allowed: false, retryAfter: 60 });
    for (let i = 0; i < 15; i++) {
      const p = controller.acquire(`rotated-${i}`);
      expect(p.allowed).toBe(true);
      if (p.allowed) p.release();
    }
    expect(controller.acquire().allowed).toBe(false);
    now = 60_000;
    expect(controller.acquire("same").allowed).toBe(true);
  });
  it("expires session buckets and fails closed when storage is full", () => {
    let now = 0;
    const controller = createAdmissionController({
      limits: { ...limits, requestsPerMinute: 3_000 },
      now: () => now,
    });
    for (let i = 0; i < 2_000; i++) {
      const p = controller.acquire(String(i));
      expect(p.allowed).toBe(true);
      if (p.allowed) p.release();
    }
    expect(controller.acquire("overflow").allowed).toBe(false);
    now = 60_000;
    expect(controller.acquire("overflow").allowed).toBe(true);
  });
});
