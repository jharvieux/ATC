// §30.7 Scenario 4 — RAG retrieval load.
//
// 1000 retrievals/sec for 5 minutes against the RAG service.
// Watch: pgvector query latency.
// Thresholds: retrieval p95 < 500ms, error < 0.1%.

import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { baseUrl, authHeaders } from "./_lib.js";

const retrieveLatency = new Trend("rag_retrieval_latency_ms");
const errorRate = new Rate("rag_retrieval_error_rate");

export const options = {
  scenarios: {
    sustained_retrieval: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    "rag_retrieval_latency_ms": ["p(95) < 500"],
    "rag_retrieval_error_rate": ["rate < 0.001"],
  },
};

const QUERIES = [
  "best balcony cabin on Royal Caribbean Symphony of the Seas",
  "Cozumel shore excursions for families with young kids",
  "is travel insurance worth it for a 7-night cruise",
  "Carnival Mardi Gras cabin recommendations honeymoon",
  "MSC Yacht Club vs Norwegian Haven comparison",
  "what's included in the cruise fare vs extra cost",
  "best time of year to cruise the Mediterranean",
  "child age requirements for kids' clubs across cruise lines",
];

export default function () {
  const ragUrl = __ENV.K6_RAG_URL || `${baseUrl()}/rag`;
  const tenantJwt = __ENV.K6_RAG_TENANT_JWT;
  if (!tenantJwt) throw new Error("K6_RAG_TENANT_JWT required");

  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];

  const start = Date.now();
  const res = http.post(
    `${ragUrl}/api/retrieve`,
    JSON.stringify({ query, scope: "all", limit: 8 }),
    {
      headers: authHeaders(tenantJwt),
      timeout: "5s",
    },
  );
  retrieveLatency.add(Date.now() - start);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "response shape valid": (r) => {
      try {
        const j = JSON.parse(r.body);
        return Array.isArray(j.chunks);
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
}

export function handleSummary(data) {
  return {
    [`reports/load/rag-retrieval-${new Date().toISOString().slice(0, 10)}.json`]: JSON.stringify(data, null, 2),
  };
}
