// §30.7 Scenario 2 — Burst signups.
//
// 100 OAuth signups in 60 seconds.
// Watch: DB connection pool, Stripe API limits.
// Thresholds: signup p95 < 3s, error < 0.1%, no Stripe 429s.

import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { baseUrl, jitter } from "./_lib.js";

const signupLatency = new Trend("signup_latency_ms");
const stripe429 = new Rate("stripe_rate_limit_hits");
const errorRate = new Rate("signup_error_rate");

export const options = {
  scenarios: {
    burst: {
      executor: "shared-iterations",
      vus: 100,
      iterations: 100,
      maxDuration: "60s",
    },
  },
  thresholds: {
    "signup_latency_ms": ["p(95) < 3000"],
    "signup_error_rate": ["rate < 0.001"],
    "stripe_rate_limit_hits": ["rate < 0.001"],
  },
};

export default function () {
  // Simulate the auth-callback path that creates the tenant + initial user.
  // Real OAuth callback can't be replayed; load endpoint must accept a
  // synthetic seed token (set K6_LOAD_SEED_TOKEN; load-test environment
  // ONLY — feature-flagged off in production via env.ts validation).
  const url = `${baseUrl()}/api/auth/signup/load-seed`;
  const seedToken = __ENV.K6_LOAD_SEED_TOKEN;
  if (!seedToken) {
    throw new Error("K6_LOAD_SEED_TOKEN required; load environment only.");
  }

  const payload = JSON.stringify({
    seed_token: seedToken,
    tenant_slug: `loadtest-${__VU}-${__ITER}-${Date.now().toString(36)}`,
    primary_email: `loadtest+${__VU}-${__ITER}@example.invalid`,
  });

  const start = Date.now();
  const res = http.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  });
  signupLatency.add(Date.now() - start);

  const ok = check(res, {
    "signup status 200/201": (r) => r.status === 200 || r.status === 201,
    "signup returned tenant_id": (r) => {
      try {
        const j = JSON.parse(r.body);
        return typeof j.tenant_id === "string";
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);

  // Track Stripe rate limits surfaced as the platform's own 429 response
  // when Stripe Connect account creation rate-limits us.
  stripe429.add(res.status === 429);

  jitter(100);
}

export function handleSummary(data) {
  return {
    [`reports/load/signups-burst-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
  };
}
