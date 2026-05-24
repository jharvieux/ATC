// §30.7 — Stripe webhook flood. 5000 webhooks in 10 minutes (~8/sec).
// Webhook-handler p95 < 500ms.
//
// IMPORTANT: requires a webhook secret matching the loadtest environment's
// STRIPE_WEBHOOK_SECRET, AND each request must include a valid
// stripe-signature header — see https://stripe.com/docs/webhooks/signatures
// for the v1=hex(hmac_sha256(timestamp + "." + payload)) construction.
//
// For load testing, run a tiny Node helper alongside to generate fresh
// signatures, or use a pre-recorded set of (timestamp, signature, payload)
// tuples in a JSON sidecar file. The skeleton below uses a sidecar.
//
// Run:
//   STRIPE_LOAD_SIGSET=./stripe-sigs.json k6 run stripe-webhook-flood.js

import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";

const BASE_URL = __ENV.BASE_URL || "https://loadtest.ai-travelconcierge.com";
const SIGSET_PATH = __ENV.STRIPE_LOAD_SIGSET || "./stripe-sigs.json";

const sigset = new SharedArray("stripe sigs", () => {
  // The sidecar JSON shape is:
  // [{ "ts": "1715000000", "sig": "v1=...", "payload": "{...}" }, ...]
  try {
    return JSON.parse(open(SIGSET_PATH));
  } catch (err) {
    console.error(
      `[stripe-webhook-flood] could not read ${SIGSET_PATH}. ` +
        "Pre-generate signed webhook payloads with scripts/build-stripe-sigset.ts.",
    );
    return [];
  }
});

export const options = {
  scenarios: {
    flood: {
      executor: "constant-arrival-rate",
      rate: 8,            // ≈ 5000 in 10 min
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed:   ["rate<0.001"],
  },
};

export default function () {
  if (sigset.length === 0) {
    throw new Error("No stripe-sig payloads available; set STRIPE_LOAD_SIGSET.");
  }
  const entry = sigset[__ITER % sigset.length];
  const res = http.post(
    `${BASE_URL}/api/webhooks/stripe/platform`,
    entry.payload,
    {
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": `t=${entry.ts},${entry.sig}`,
      },
    },
  );
  check(res, { "webhook accepted (200 or 202)": (r) => r.status === 200 || r.status === 202 });
}
