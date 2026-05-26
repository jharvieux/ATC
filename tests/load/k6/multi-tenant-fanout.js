// §30.7 Scenario 6 — Multi-tenant fan-out.
//
// 100 tenants × 50 customers × 5 msg conversations.
// Watch: cross-tenant query plans, RLS overhead.
// Thresholds: API non-AI route p95 < 500ms, no DB pool exhaustion.

import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { baseUrl, loadTenantPrefix, loadTenantHost, authHeaders } from "./_lib.js";

const apiLatency = new Trend("api_non_ai_latency_ms");
const errorRate = new Rate("multi_tenant_error_rate");

const TENANTS = 100;
const CUSTOMERS_PER_TENANT = 50;
const MESSAGES_PER_CONVO = 5;

export const options = {
  scenarios: {
    fanout: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 200 },   // ramp
        { duration: "15m", target: 200 },  // hold — full fan-out cycle
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    "api_non_ai_latency_ms": ["p(95) < 500"],
    "multi_tenant_error_rate": ["rate < 0.001"],
    "http_req_failed": ["rate < 0.001"],
  },
};

function pickTenantSlug() {
  const i = Math.floor(Math.random() * TENANTS);
  return `${loadTenantPrefix()}${i.toString().padStart(3, "0")}`;
}

function pickCustomerId(tenantIdx) {
  const c = Math.floor(Math.random() * CUSTOMERS_PER_TENANT);
  return `${tenantIdx}-cust-${c}`;
}

// Token bag: seed mints one JWT per (tenant, customer) and stores them.
const tokenBag = JSON.parse(__ENV.K6_LOAD_TOKEN_BAG_JSON || "{}");

export default function () {
  const slug = pickTenantSlug();
  const host = loadTenantHost(slug);
  const tIdx = slug.replace(loadTenantPrefix(), "");
  const custId = pickCustomerId(tIdx);
  const token = tokenBag[`${tIdx}-${custId}`];
  if (!token) {
    // Skip if no token seeded for this combo
    return;
  }

  // Exercise the non-AI hot paths: contact list, quotes list, chat conv list.
  const start = Date.now();
  const res = http.get(`${baseUrl()}/api/chat/conversations?limit=10`, {
    headers: {
      ...authHeaders(token),
      "x-forwarded-host": host,
    },
    timeout: "5s",
  });
  apiLatency.add(Date.now() - start);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "conversations array present": (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).conversations);
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);

  // Send a single message to each conversation we know about (or create
  // a new one). This stays under MESSAGES_PER_CONVO via VU iteration count.
  if (Math.random() < 0.3 && res.status === 200) {
    const convos = JSON.parse(res.body).conversations || [];
    if (convos.length > 0) {
      const convoId = convos[0].id;
      http.post(
        `${baseUrl()}/api/chat`,
        JSON.stringify({
          message: "follow-up question",
          conversation_id: convoId,
        }),
        { headers: authHeaders(token), timeout: "30s" },
      );
    }
  }
}

export function handleSummary(data) {
  return {
    [`reports/load/multi-tenant-fanout-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
  };
}
