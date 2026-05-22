/** Spec ref: §7.9a — Inngest serve endpoint */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { stripeWebhookIncompleteReconcile } from "@/inngest/stripe-webhook-incomplete-reconcile";
import { ragSyncRetry, ragSyncCleanup } from "@/inngest/rag-sync-retry";
import { extractMemory } from "@/inngest/extract-memory";
import { dobEstimateRepromptEligible } from "@/inngest/dob-estimate-reprompt-eligible";
import { transferFinalize } from "@/inngest/transfer-finalize";
import { reEncryptOldRecords, backupVerificationReminder } from "@/inngest/re-encrypt-old-records";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    stripeWebhookIncompleteReconcile,
    ragSyncRetry,
    ragSyncCleanup,
    extractMemory,
    dobEstimateRepromptEligible,
    transferFinalize,
    reEncryptOldRecords,
    backupVerificationReminder,
  ],
});
