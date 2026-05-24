// §30.7 — burst signup load. 100 OAuth signups in 60 seconds.
// Signup p95 < 3s, error rate < 0.1%.
//
// Run:
//   BASE_URL=https://loadtest.example k6 run burst-signups.js

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://loadtest.ai-travelconcierge.com";

export const options = {
  scenarios: {
    burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "40s", target: 5 },  // sustained 5/s ≈ 100 in 60s
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    http_req_failed:   ["rate<0.001"],
  },
};

export default function () {
  // Synthetic OAuth initiation — mimics the public oauth-initiate route.
  const res = http.get(`${BASE_URL}/api/auth/oauth-initiate?provider=google&intent=signup`);
  check(res, {
    "initiates oauth (302 or 200 with redirect URL)": (r) => r.status === 302 || r.status === 200,
  });
}
