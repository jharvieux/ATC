import { Redis } from "ioredis";

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    // Resilience tuning for the inter-service auth hot path (#787). The default
    // maxRetriesPerRequest:1 fail-closed ~9% of CruiseMapper ingest auth checks
    // at cold-start, while the connection was still establishing under the
    // cron's burst — every verifyServiceJwt call does a Redis SET NX, and a
    // transient blip there returns redis_unreachable (503). A few command
    // retries plus a bounded reconnect backoff let those ride out the blip
    // instead of dropping the ingest.
    //
    // Trade-off (accepted): retrying a SET NX whose OK response was lost after
    // the server applied it can read the key back as existing and report a
    // spurious `replay` (401). The window is narrow, already existed at
    // retries:1, and self-heals (the dropped call retries with a fresh jti) —
    // a net win over the common cold-start redis_unreachable it prevents.
    _redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
  }
  return _redis;
}
