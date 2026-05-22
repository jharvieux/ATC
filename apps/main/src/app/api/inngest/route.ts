/** Spec ref: §7.9a — Inngest serve endpoint */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { stripeWebhookIncompleteReconcile } from "@/inngest/stripe-webhook-incomplete-reconcile";
import { ragSyncRetry, ragSyncCleanup } from "@/inngest/rag-sync-retry";
import { extractMemory } from "@/inngest/extract-memory";
import { dobEstimateRepromptEligible } from "@/inngest/dob-estimate-reprompt-eligible";
import { transferFinalize } from "@/inngest/transfer-finalize";
import { reEncryptOldRecords, backupVerificationReminder } from "@/inngest/re-encrypt-old-records";
import { commissionSplitOnReceived } from "@/inngest/commission-split-on-received";
import { payoutsMarkAvailable } from "@/inngest/payouts-mark-available";
import { payoutsExecuteTransfer } from "@/inngest/payouts-execute-transfer";
import { payoutsReconcileProcessing } from "@/inngest/payouts-reconcile-processing";
import { reconcileStatementAutomated } from "@/inngest/reconcile-statement-automated";

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
    commissionSplitOnReceived,
    payoutsMarkAvailable,
    payoutsExecuteTransfer,
    payoutsReconcileProcessing,
    reconcileStatementAutomated,
  ],
});
