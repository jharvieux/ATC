// §30.7 — multi-tenant fanout. 100 tenants × 50 customers × 5-msg conversations
// = 25,000 chat turns total. Exercises tenant-isolation under concurrent
// cross-tenant load.
//
// Run:
//   BASE_URL=https://loadtest.example LOADTEST_TENANT_TOKENS=./tenant-tokens.json k6 run multi-tenant-fanout.js
//
// LOADTEST_TENANT_TOKENS sidecar JSON shape:
//   [{ "tenant_id": "...", "customer_tokens": ["bearer1", "bearer2", ...] }, ...]

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

const BASE_URL = __ENV.BASE_URL || "https://loadtest.ai-travelconcierge.com";
const TOKENS_PATH = __ENV.LOADTEST_TENANT_TOKENS || "./tenant-tokens.json";

const tenants = new SharedArray("tenants", () => {
  try {
    return JSON.parse(open(TOKENS_PATH));
  } catch (err) {
    console.error(`[multi-tenant-fanout] could not read ${TOKENS_PATH}.`);
    return [];
  }
});

export const options = {
  scenarios: {
    fanout: {
      executor: "per-vu-iterations",
      vus: 100,              // one VU per tenant
      iterations: 250,       // 50 customers × 5 messages
      maxDuration: "60m",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<5000"],
    http_req_failed:   ["rate<0.001"],
  },
};

export default function () {
  if (tenants.length === 0) {
    throw new Error("No tenant tokens available; set LOADTEST_TENANT_TOKENS.");
  }
  const tenant = tenants[__VU % tenants.length];
  const customerToken = tenant.customer_tokens[__ITER % tenant.customer_tokens.length];

  const convoId = `loadtest-${tenant.tenant_id}-vu${__VU}-iter${__ITER}`;
  const res = http.post(
    `${BASE_URL}/api/chat`,
    JSON.stringify({
      conversation_id: convoId,
      message: "Suggest an itinerary for two adults, March.",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${customerToken}`,
        "x-resolved-tenant-id": tenant.tenant_id,
      },
    },
  );
  check(res, {
    "chat 200": (r) => r.status === 200,
    "no cross-tenant leak in body": (r) => {
      // Cheap leak heuristic: the response body should not contain any
      // OTHER tenant_id from our tenant set.
      const body = r.body || "";
      const others = tenants
        .filter((t) => t.tenant_id !== tenant.tenant_id)
        .some((t) => body.toString().includes(t.tenant_id));
      return !others;
    },
  });
  // Small pacing to avoid back-to-back same-conversation hits triggering
  // anti-abuse limits.
  sleep(1);
}
