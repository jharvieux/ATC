import { Redis } from "ioredis";

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    _redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }
  return _redis;
}
