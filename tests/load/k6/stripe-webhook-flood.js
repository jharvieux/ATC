// §30.7 Scenario 5 — Stripe webhook flood.
//
// 5000 webhooks in 10 minutes (simulating statement-period close).
// Watch: idempotency, processing latency.
// Thresholds: webhook p95 < 2s, idempotency holds (no duplicate processing),
// error < 0.1%.

import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";
import { Rate, Trend } from "k6/metrics";
import { baseUrl } from "./_lib.js";

const webhookLatency = new Trend("stripe_webhook_latency_ms");
const errorRate = new Rate("stripe_webhook_error_rate");

export const options = {
  scenarios: {
    flood: {
      executor: "constant-arrival-rate",
      rate: 500,            // 500/min = 5000 over 10 min
      timeUnit: "1m",
      duration: "10m",
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    "stripe_webhook_latency_ms": ["p(95) < 2000"],
    "stripe_webhook_error_rate": ["rate < 0.001"],
  },
};

function makeSignature(rawBody, secret, timestamp) {
  const payload = `${timestamp}.${rawBody}`;
  const sig = crypto.hmac("sha256", secret, payload, "hex");
  return `t=${timestamp},v1=${sig}`;
}

function randomTransferEvent() {
  const eventId = `evt_load_${__VU}_${__ITER}_${Date.now()}`;
  const transferId = `tr_load_${Math.random().toString(36).slice(2, 12)}`;
  return {
    id: eventId,
    type: "transfer.paid",
    data: {
      object: {
        id: transferId,
        amount: Math.floor(Math.random() * 100000) + 1000,
        currency: "usd",
        destination: `acct_load_${__VU}`,
      },
    },
    created: Math.floor(Date.now() / 1000),
  };
}

export default function () {
  const secret = __ENV.K6_STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("K6_STRIPE_WEBHOOK_SECRET required");

  const event = randomTransferEvent();
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = makeSignature(rawBody, secret, timestamp);

  const start = Date.now();
  const res = http.post(`${baseUrl()}/api/webhooks/stripe`, rawBody, {
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": sig,
    },
    timeout: "5s",
  });
  webhookLatency.add(Date.now() - start);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
  });
  errorRate.add(!ok);
}

export function handleSummary(data) {
  return {
    [`reports/load/stripe-webhook-flood-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
  };
}
