// §27.12 — Batch reconciler. Every 15 minutes, polls submitted
// ai_batch_jobs against Anthropic and processes completed ones.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { reconcileSubmittedBatches } from "@/lib/ai/batch/reconcile";
import { adoptStrandedBatches } from "@/lib/ai/batch/adopt";

export const aiBatchReconcile = inngest.createFunction(
  {
    id: "ai-batch-reconcile",
    // 15-min cadence (#894 Inngest cost): Anthropic batches take minutes-to-
    // hours, so a slower poll only delays completion processing slightly.
    triggers: [{ cron: "*/15 * * * *" }],
    // Avoid concurrent runs of the reconciler — two reconciliations
    // racing on the same batch could double-emit completion events.
    concurrency: { limit: 1 },
  },
  async () => {
    const db = createServiceRoleClient();
    // #1696 — recover rows stranded by a crash between submit and job-link
    // FIRST, so any job this creates gets polled by the same reconcile pass.
    const adopted = await adoptStrandedBatches({ db });
    const result = await reconcileSubmittedBatches({ db });
    return { ...result, adopted };
  },
);
