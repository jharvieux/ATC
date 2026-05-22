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
import { complianceNightly } from "@/inngest/compliance-nightly";
import { tenantTerminationScheduled, tenantOnTerminatedSideEffects } from "@/inngest/tenant-on-terminated";
import { ragTenantScopedPurgeOnTermination } from "@/inngest/rag-tenant-scoped-purge";
import { userDataExportBuild } from "@/inngest/user-data-export-build";
import { userDataPurgeAfterGrace } from "@/inngest/user-data-purge-after-grace";
import { ccpaStagingPropagationMonitor } from "@/inngest/ccpa-staging-propagation-monitor";
import { customDomainReverify } from "@/inngest/custom-domain-reverify";
import { customDomainTxtGraceSweep } from "@/inngest/custom-domain-txt-grace-sweep";
import {
  customDomainCleanupOnSuspend,
  customDomainCleanupOnTerminated,
  customDomainCleanupOnDowngrade,
  customDomainCleanupOnTenantRemoval,
} from "@/inngest/custom-domain-cleanup-on-lifecycle";
import { crownJewelAnnualAudit } from "@/inngest/crown-jewel-annual-audit";
import { personaAddendumScreen } from "@/inngest/persona-addendum-screen";
import { personaAddendumRescreenNightly } from "@/inngest/persona-addendum-rescreen-nightly";

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
    complianceNightly,
    tenantTerminationScheduled,
    tenantOnTerminatedSideEffects,
    ragTenantScopedPurgeOnTermination,
    userDataExportBuild,
    userDataPurgeAfterGrace,
    ccpaStagingPropagationMonitor,
    customDomainReverify,
    customDomainTxtGraceSweep,
    customDomainCleanupOnSuspend,
    customDomainCleanupOnTerminated,
    customDomainCleanupOnDowngrade,
    customDomainCleanupOnTenantRemoval,
    crownJewelAnnualAudit,
    personaAddendumScreen,
    personaAddendumRescreenNightly,
  ],
});
