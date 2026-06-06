// #787 — the RAG Redis client must ride out transient blips under the cron's
// burst instead of fail-closing every verifyServiceJwt SET NX. `lazyConnect`
// means constructing the client opens no socket, so we can read back its
// resolved options without a live Redis.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRedis } from "../../src/lib/redis/client";

describe("getRedis options — resilience under burst (#787)", () => {
  const prev = process.env.REDIS_URL;
  beforeEach(() => {
    process.env.REDIS_URL = "rediss://example.invalid:6379";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });

  it("retries each command more than once before failing closed", () => {
    expect(getRedis().options.maxRetriesPerRequest).toBe(3);
  });

  it("reconnects with a bounded backoff that grows then caps at 2s", () => {
    const rs = getRedis().options.retryStrategy;
    expect(typeof rs).toBe("function");
    if (typeof rs !== "function") return;
    expect(rs(1)).toBe(200);
    expect(rs(5)).toBe(1000);
    expect(rs(100)).toBe(2000); // capped
  });
});
