// §30.7 Scenario 3 — Group invite blast.
//
// 1000-invitee group send (single coordinator → 1000 invitees).
// Watch: email queue, Resend rate limits.
// Thresholds: send p95 < 30s, no email-queue depth growth past 5000.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { baseUrl, authHeaders } from "./_lib.js";

const inviteLatency = new Trend("invite_send_latency_ms");
const resendThrottle = new Rate("resend_throttle_hits");
const errorRate = new Rate("invite_error_rate");

export const options = {
  scenarios: {
    blast: {
      executor: "per-vu-iterations",
      vus: 1,                 // one coordinator
      iterations: 1,          // one big group
      maxDuration: "5m",
    },
  },
  thresholds: {
    "invite_send_latency_ms": ["p(95) < 30000"],
    "invite_error_rate": ["rate < 0.001"],
    "resend_throttle_hits": ["rate < 0.01"],
  },
};

export default function () {
  const token = __ENV.K6_TOKEN;
  if (!token) throw new Error("K6_TOKEN (coordinator JWT) required.");

  // 1. Create the group.
  const createRes = http.post(
    `${baseUrl()}/api/groups`,
    JSON.stringify({
      name: `Load test group ${Date.now()}`,
      destination: "Caribbean",
      sailing_date: "2026-12-01",
    }),
    { headers: authHeaders(token) },
  );
  check(createRes, {
    "group created": (r) => r.status === 201 || r.status === 200,
  });
  const groupId = JSON.parse(createRes.body).id;

  // 2. Invite 1000 placeholder addresses.
  const invitees = [];
  for (let i = 0; i < 1000; i++) {
    invitees.push({ email: `loadtest+invitee${i}@example.invalid` });
  }
  const start = Date.now();
  const inviteRes = http.post(
    `${baseUrl()}/api/groups/${groupId}/invitations/bulk`,
    JSON.stringify({ invitees }),
    { headers: authHeaders(token), timeout: "60s" },
  );
  inviteLatency.add(Date.now() - start);

  const ok = check(inviteRes, {
    "bulk invite status 200/202": (r) => r.status === 200 || r.status === 202,
    "queued count matches": (r) => {
      try { return JSON.parse(r.body).queued === 1000; }
      catch { return false; }
    },
  });
  errorRate.add(!ok);
  resendThrottle.add(inviteRes.status === 429);

  // 3. Poll queue depth — keep checking for 2 minutes. Depth above 5000
  // indicates the email send queue can't keep up.
  for (let t = 0; t < 24; t++) {
    sleep(5);
    const stats = http.get(`${baseUrl()}/api/admin/email-queue/depth`, {
      headers: authHeaders(token),
    });
    if (stats.status === 200) {
      const depth = JSON.parse(stats.body).queued || 0;
      check(stats, { "queue depth < 5000": () => depth < 5000 });
      if (depth === 0) break;
    }
  }
}

export function handleSummary(data) {
  return {
    [`reports/load/group-invite-blast-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
  };
}
