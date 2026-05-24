// §30.7 — RAG retrieval load. 1000 retrievals/sec for 5 minutes.
// Retrieval p95 < 500ms.
//
// Run against the RAG SERVICE URL, not the main app.
//   RAG_BASE_URL=https://rag.loadtest.example k6 run rag-retrieval-load.js

import http from "k6/http";
import { check } from "k6";

const RAG_BASE_URL = __ENV.RAG_BASE_URL || "https://rag.loadtest.ai-travelconcierge.com";

export const options = {
  scenarios: {
    retrievals: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed:   ["rate<0.001"],
  },
};

const QUERIES = [
  "What's the deposit policy for Royal Caribbean?",
  "Are there formal nights on a 7-night Caribbean itinerary?",
  "Can my mom bring her wheelchair on Carnival?",
  "Do passport stamps still happen for closed-loop sailings?",
  "What's the cancellation window for Disney Cruise Line?",
];

export default function () {
  const query = QUERIES[__ITER % QUERIES.length];
  const res = http.post(
    `${RAG_BASE_URL}/retrieve`,
    JSON.stringify({
      query,
      tenant_id: __ENV.LOADTEST_TENANT_ID || "REPLACE_WITH_LOADTEST_TENANT_ID",
      top_n: 4,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${__ENV.LOADTEST_SERVICE_JWT || "REPLACE_WITH_SERVICE_JWT"}`,
      },
    },
  );
  check(res, {
    "retrieves chunks": (r) => r.status === 200,
    "non-empty response": (r) => r.body && r.body.length > 100,
  });
}
