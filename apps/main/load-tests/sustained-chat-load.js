// §30.7 — sustained chat load. 500 concurrent conversations for 30 minutes.
// Chat p95 < 5s, error rate under load < 0.1%.
//
// Run:
//   BASE_URL=https://loadtest.example k6 run sustained-chat-load.js
// Tune:
//   VUS, DURATION

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://loadtest.ai-travelconcierge.com";
const VUS = parseInt(__ENV.VUS || "500", 10);
const DURATION = __ENV.DURATION || "30m";

export const options = {
  scenarios: {
    sustained_chat: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<5000"],   // chat p95 < 5s
    http_req_failed:   ["rate<0.001"],   // error rate < 0.1%
  },
};

export default function () {
  // Pick a synthetic user/conversation seed deterministically per VU so
  // distinct virtual users hit distinct conversations.
  const convoId = `loadtest-convo-${__VU}-${__ITER}`;
  const res = http.post(
    `${BASE_URL}/api/chat`,
    JSON.stringify({
      conversation_id: convoId,
      message: "Hi, looking for a 7-night Caribbean cruise in March for 2 adults.",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${__ENV.LOADTEST_BEARER || "REPLACE_WITH_LOADTEST_TOKEN"}`,
      },
    },
  );
  check(res, {
    "status is 200": (r) => r.status === 200,
    "response under 5s": (r) => r.timings.duration < 5000,
  });
  // Pace at roughly 1 message every 30s per VU to mimic real users.
  sleep(30);
}
