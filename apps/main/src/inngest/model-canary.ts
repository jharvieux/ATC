// #851 PR3 — daily model canary cron.
//
// Pings every configured model once a day; alerts the operator if any is
// unavailable (retired/deprecated/access). With Anthropic's months-long
// deprecation notice this catches a retirement with huge runway — the runtime
// fallback chain (#851 PR2) is only the gap insurance. Best-effort + LOUD:
// failures alert, they don't silently pass.

import { inngest } from "./client";
import { runModelCanary } from "@/lib/ai/model-canary";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

export const modelCanary = inngest.createFunction(
  { id: "model-canary", triggers: [{ cron: "0 6 * * *" }] },
  async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[model-canary] ANTHROPIC_API_KEY not set — cannot verify configured models");
      return { skipped: true, reason: "no_api_key" };
    }

    const { checked, failures } = await runModelCanary(apiKey);

    if (failures.length > 0) {
      await sendOperatorAlert({
        severity: "high",
        signal: "model_canary_unavailable",
        detail:
          `${failures.length} of ${checked.length} configured Anthropic model(s) failed a canary ping — ` +
          `likely retired/deprecated. Update the chains in apps/main/src/lib/ai/models.ts. ` +
          failures.map((f) => `${f.model} [${f.status}]`).join(", "),
        payload: { checked, failures },
      });
    } else {
      console.log(`[model-canary] all ${checked.length} configured models healthy`);
    }

    return { checked: checked.length, failures: failures.length };
  },
);
