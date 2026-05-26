// §30.7 Scenario 1 — Sustained chat load.
//
// 500 concurrent conversations, 30 minutes.
// Watch: AI latency, supervisor overhead.
// Thresholds: chat p95 < 5s end-to-end (including streaming), error < 0.1%.
//
// Run:
//   K6_BASE_URL=... K6_TOKEN=... k6 run tests/load/k6/chat-sustained.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";
import { baseUrl, authHeaders, jitter } from "./_lib.js";

const chatLatency = new Trend("chat_e2e_latency_ms");
const errorRate = new Rate("chat_error_rate");

export const options = {
  scenarios: {
    sustained: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 500 },   // ramp to 500 VUs
        { duration: "30m", target: 500 },  // hold for 30 minutes
        { duration: "1m", target: 0 },     // ramp down
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    "chat_e2e_latency_ms": ["p(95) < 5000"],
    "chat_error_rate": ["rate < 0.001"],
    "http_req_failed": ["rate < 0.001"],
  },
};

const PROMPTS = [
  "I'm looking for a 7-day Caribbean cruise in March for two adults.",
  "What's the difference between an oceanview and a balcony cabin?",
  "Can you suggest some excursions in Cozumel?",
  "We have a 12-year-old and a 6-year-old — what cruise lines are best for families?",
  "Is travel insurance worth it for a cruise?",
  "What does the gratuity actually cover?",
];

function pickPrompt() {
  return PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
}

export default function () {
  const url = `${baseUrl()}/api/chat`;
  const payload = JSON.stringify({
    message: pickPrompt(),
    conversation_id: null,
  });
  const start = Date.now();
  const res = http.post(url, payload, {
    headers: authHeaders(__ENV.K6_TOKEN),
    // SSE — collect until [DONE].
    timeout: "60s",
  });
  const elapsed = Date.now() - start;
  chatLatency.add(elapsed);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "stream contained [DONE]": (r) => r.body && r.body.includes("[DONE]"),
  });
  errorRate.add(!ok);

  jitter(750);
}

export function handleSummary(data) {
  return {
    [`reports/load/chat-sustained-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const m = data.metrics;
  return `\n=== chat-sustained summary ===
chat p50: ${m.chat_e2e_latency_ms?.["p(50)"]?.toFixed(0)}ms
chat p95: ${m.chat_e2e_latency_ms?.["p(95)"]?.toFixed(0)}ms
chat p99: ${m.chat_e2e_latency_ms?.["p(99)"]?.toFixed(0)}ms
errors:   ${(m.chat_error_rate?.rate * 100)?.toFixed(2)}%
requests: ${m.http_reqs?.count}
\n`;
}
