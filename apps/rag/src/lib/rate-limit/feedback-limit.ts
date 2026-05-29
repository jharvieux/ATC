// §6.10 / D-087 — Rate limit for the /api/feedback inbound endpoint.
//
// The endpoint accepts HMAC-signed POSTs from the main app and writes
// per-chunk feedback events. Even though the HMAC secret is operator-
// rotated, a leaked secret could be used to flood the events table with
// spam signal. The rate limit is a defense-in-depth layer that bounds
// blast radius independent of the auth secret.
//
// Counter keyed by ${remote_addr}+${secret_hint} so:
//   - A leaked secret used from one host can be rate-limited at that host
//   - A legitimate caller on a different IP can use the same secret
//   - The remote_addr falls back to "unknown" if upstream doesn't set
//     the standard headers; the rate-limit still applies, just bucketed
//     under the catch-all key.

import { getRedis } from "@/lib/redis/client";

const DEFAULT_LIMIT_PER_MIN = 120;
const WINDOW_SECONDS = 60;

function limitPerMinute(): number {
  const raw = Number(process.env.FEEDBACK_RATE_LIMIT_PER_MIN ?? DEFAULT_LIMIT_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT_PER_MIN;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset_seconds: number;
}

export async function checkFeedbackRateLimit(
  req: Request,
  secretHint: string,
): Promise<RateLimitResult> {
  const fwd = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  const remote = (fwd ?? "unknown").split(",")[0]!.trim();
  const key = `rl:feedback:${remote}:${secretHint}`;
  const limit = limitPerMinute();

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    // getRedis throws only when REDIS_URL is unset. In any deployed env that
    // can't happen — env.ts requires REDIS_URL and verifyEnvAtBoot crashes the
    // process at boot otherwise — so reaching here in production means the
    // rate-limit enforcement layer genuinely cannot run: fail CLOSED (D-091).
    // In local dev (no REDIS_URL) keep the endpoint usable by failing open.
    // NODE_ENV === "production" is the proxy for "verifyEnvAtBoot is in force";
    // staging runs in production mode too, so it correctly fails closed there.
    if (process.env.NODE_ENV === "production") throw err;
    console.warn("[feedback-rate-limit] REDIS_URL not set — fail-open (non-production)");
    return { allowed: true, remaining: limit, reset_seconds: WINDOW_SECONDS };
  }

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  const ttl = await redis.ttl(key);
  const reset = ttl > 0 ? ttl : WINDOW_SECONDS;
  const remaining = Math.max(0, limit - count);

  return { allowed: count <= limit, remaining, reset_seconds: reset };
}
