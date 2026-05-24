// §30.7 — group invite blast. A single group with 1000 invitees.
// Invite-send completion under 60 seconds; per-invite p95 < 500ms.
//
// Run:
//   BASE_URL=https://loadtest.example GROUP_ID=<uuid> k6 run group-invite-blast.js

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://loadtest.ai-travelconcierge.com";
const GROUP_ID = __ENV.GROUP_ID || "REPLACE_WITH_LOADTEST_GROUP_ID";
const INVITEE_COUNT = parseInt(__ENV.INVITEE_COUNT || "1000", 10);

export const options = {
  scenarios: {
    blast: {
      executor: "shared-iterations",
      vus: 50,
      iterations: INVITEE_COUNT,
      maxDuration: "120s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed:   ["rate<0.001"],
    iteration_duration: ["p(95)<2000"],
  },
};

export default function () {
  const inviteeEmail = `loadtest-invitee-${__ITER}@example.test`;
  const res = http.post(
    `${BASE_URL}/api/groups/${GROUP_ID}/invitations`,
    JSON.stringify({ email: inviteeEmail }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${__ENV.LOADTEST_BEARER || "REPLACE_WITH_LOADTEST_TOKEN"}`,
      },
    },
  );
  check(res, { "invite accepted": (r) => r.status === 200 || r.status === 201 });
}
