// #393 / D-091 — feedback rate-limit must fail CLOSED in production.
//
// getRedis() throws only when REDIS_URL is unset. env.ts marks REDIS_URL
// required and verifyEnvAtBoot crashes the process at boot otherwise, so in a
// deployed environment this can't happen — but if it somehow does, the rate
// limit genuinely cannot run and the answer must be denial, not "allow". In
// local dev (no REDIS_URL) the endpoint stays usable by failing open.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/redis/client", () => ({
  getRedis: () => {
    throw new Error("REDIS_URL is not set");
  },
}));

import { checkFeedbackRateLimit } from "@/lib/rate-limit/feedback-limit";

afterEach(() => {
  vi.unstubAllEnvs();
});

function req(): Request {
  return new Request("http://test/api/feedback", { method: "POST" });
}

describe("checkFeedbackRateLimit — fail-closed when Redis unavailable (#393)", () => {
  it("THROWS in production when REDIS_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(checkFeedbackRateLimit(req(), "hint")).rejects.toThrow(/REDIS_URL is not set/);
  });

  it("fails OPEN in non-production so local dev stays usable", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await checkFeedbackRateLimit(req(), "hint");
    expect(res.allowed).toBe(true);
  });
});
