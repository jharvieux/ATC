// §25.5 — Annual reminder to review the sub-processors disclosure.
//
// Fires once a year (January 1). The list itself is rendered at
// /legal/sub-processors and is operator-maintained text.

import { inngest } from "./client";

export const subprocessorsAnnualReview = inngest.createFunction(
  {
    id: "subprocessors-annual-review",
    triggers: [{ cron: "0 11 1 1 *" }], // Jan 1 at 11:00 UTC
  },
  async () => {
    console.warn(
      "[subprocessors-annual-review] " + JSON.stringify({
        message: "Annual sub-processors disclosure review due.",
        docs: "/legal/sub-processors",
        checklist: [
          "Confirm each listed vendor is still in use",
          "Add any new vendors that have been onboarded since last review",
          "Verify data category descriptions still match actual use",
          "Update the page's last-reviewed date",
        ],
        spec: "§25.5",
      }),
    );
    return { ok: true };
  },
);
