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
// BP19: Group bookings (§18)
import { invitationTokensNaturalExpirySweep } from "@/inngest/invitation-tokens-natural-expiry-sweep";
import { groupsMarkSailed } from "@/inngest/groups-mark-sailed";
import { groupReminderCadence } from "@/inngest/group-reminder-cadence";
// BP20: Forum moderation (§19)
import { forumModerationRetry } from "@/inngest/forum-moderation-retry";
import { forumModerationTimeoutSweep } from "@/inngest/forum-moderation-timeout-sweep";
// BP21: Quote pricing discipline (§21.10.1)
import { quoteEstimateExpirySweep } from "@/inngest/quote-estimate-expiry-sweep";
// BP22: RAG ingestion pipeline (§22)
import { ragExtractContent } from "@/inngest/rag-extract-content";
import { ragPiiRedact } from "@/inngest/rag-pii-redact";
import { ragNormalize } from "@/inngest/rag-normalize";
import { ragTenantApprovalRateNightly } from "@/inngest/rag-tenant-approval-rate-nightly";
// BP23: Email infrastructure + in-app notifications (§23)
import { preCruiseEmailScheduler } from "@/inngest/pre-cruise-email-scheduler";
import { precruiseGenerateAndSend } from "@/inngest/precruise-generate-and-send";
import { emailSoftBounceRetry } from "@/inngest/email-soft-bounce-retry";
// BP24: Chat UI maintenance crons (§24)
import { anonymousChatCounterCleanup } from "@/inngest/anonymous-chat-counter-cleanup";
import { customerChatCounterRecompute } from "@/inngest/customer-chat-counter-recompute";
import { denylistQuarterlyReviewReminder } from "@/inngest/denylist-quarterly-review-reminder";
// BP25: Retention crons (§25.2)
import { anonymousSessionCleanup } from "@/inngest/anonymous-session-cleanup";
import { ragRejectedItemsPurge } from "@/inngest/rag-rejected-items-purge";
import { bookingCommissionRetentionPurge } from "@/inngest/booking-commission-retention-purge";
import { subprocessorsAnnualReview } from "@/inngest/subprocessors-annual-review";
// BP26: Forensics retention (§26.5a)
import { forensicsLogPurgeCron } from "@/inngest/forensics-log-purge-cron";
// BP26: Vendor health probe (§26.9)
import { vendorHealthProbe } from "@/inngest/vendor-health-probe";
// BP26: §26.6 monitoring crons
import { authFailureMonitor } from "@/inngest/auth-failure-monitor";
import { permissionDeniedMonitor } from "@/inngest/permission-denied-monitor";
import { crossTenantRlsBypassMonitor } from "@/inngest/cross-tenant-rls-bypass-monitor";
// BP27: SaaS abuse monitoring + cost controls (§27)
import { aiPricingCacheRefresh } from "@/inngest/ai-pricing-cache-refresh";
import { emailBounceRateMonitor } from "@/inngest/email-bounce-rate-monitor";
import { qualityLowApprovalSignal } from "@/inngest/quality-low-approval-signal";
import { duplicateHighRateSignal } from "@/inngest/duplicate-high-rate-signal";
import { abuseSignalRagPiiRecurring, abuseSignalAnonChatBurst } from "@/inngest/abuse-signal-consumers";
// BP28: SaaS abuse — dashboard / overrides / nightly recompute (§27.7 / §27.9 / §27.11 / §27.14)
import { abuseRecomputeNightly } from "@/inngest/abuse-recompute-nightly";
import { billingPeriodRollover } from "@/inngest/billing-period-rollover";
import { thresholdRecomputeOnSubscriptionChange } from "@/inngest/threshold-recompute-on-subscription-change";
import { abuseStateTransitionNotify } from "@/inngest/abuse-state-transition-notify";
import { abuseOverrideExpirySweep } from "@/inngest/abuse-override-expiry-sweep";
import { githubIssueRetry } from "@/inngest/github-issue-retry";
import { helpDocsPdfGenerate } from "@/inngest/help-docs-pdf-generate";
import { helpDocsDocxGenerate } from "@/inngest/help-docs-docx-generate";
import { helpDocVersionsPurge } from "@/inngest/help-doc-versions-purge";
import { helpSubmissionDailyReset } from "@/inngest/help-submission-daily-reset";
// BP35 §33.4 — CruiseMapper itinerary monthly refresh
import { refreshCruisemapperItineraries } from "@/inngest/refresh-cruisemapper-itineraries";
// BP36 §33.5 — CruiseMapper DIY static quarterly refresh
import { refreshCruisemapperStatic } from "@/inngest/refresh-cruisemapper-static";
// BP40 §33.8 — Price-watch daily evaluator
import { evaluatePriceWatches } from "@/inngest/evaluate-price-watches";
// BP37 §37 — Tasks: sequence step firing + reminder cron + system generators
import { taskSequenceStepFire } from "@/inngest/task-sequence-step-fire";
import { taskRemindersFire } from "@/inngest/task-reminders-fire";
import {
  systemTaskPassportExpiring,
  systemTaskFinalPayment,
  systemTaskQuoteExpiring,
  systemTaskPostTrip,
  systemTaskLeadAging,
  systemTaskCommissionRateMissing,
} from "@/inngest/system-task-generators";

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
    // BP19: Group bookings (§18)
    invitationTokensNaturalExpirySweep,
    groupsMarkSailed,
    groupReminderCadence,
    // BP20: Forum moderation (§19)
    forumModerationRetry,
    forumModerationTimeoutSweep,
    // BP21: Quote pricing discipline (§21.10.1)
    quoteEstimateExpirySweep,
    // BP22: RAG ingestion pipeline (§22)
    ragExtractContent,
    ragPiiRedact,
    ragNormalize,
    ragTenantApprovalRateNightly,
    // BP23: Email infrastructure + in-app notifications (§23)
    preCruiseEmailScheduler,
    precruiseGenerateAndSend,
    emailSoftBounceRetry,
    // BP24: Chat UI maintenance crons (§24)
    anonymousChatCounterCleanup,
    customerChatCounterRecompute,
    denylistQuarterlyReviewReminder,
    // BP25: Retention crons (§25.2)
    anonymousSessionCleanup,
    ragRejectedItemsPurge,
    bookingCommissionRetentionPurge,
    subprocessorsAnnualReview,
    // BP26: Forensics retention (§26.5a)
    forensicsLogPurgeCron,
    // BP26: Vendor health probe (§26.9)
    vendorHealthProbe,
    // BP26: §26.6 monitoring crons
    authFailureMonitor,
    permissionDeniedMonitor,
    crossTenantRlsBypassMonitor,
    // BP27: SaaS abuse monitoring + cost controls (§27)
    aiPricingCacheRefresh,
    emailBounceRateMonitor,
    qualityLowApprovalSignal,
    duplicateHighRateSignal,
    abuseSignalRagPiiRecurring,
    abuseSignalAnonChatBurst,
    // BP28: SaaS abuse — dashboard / overrides / nightly recompute (§27.7 / §27.9 / §27.11 / §27.14)
    abuseRecomputeNightly,
    billingPeriodRollover,
    thresholdRecomputeOnSubscriptionChange,
    abuseStateTransitionNotify,
    abuseOverrideExpirySweep,
    // BP31: Self-Service Help — GitHub issue creation resilience (§32.7.5)
    githubIssueRetry,
    // BP31 Phase C: Help docs export pipeline (§32.3.3)
    helpDocsPdfGenerate,
    helpDocsDocxGenerate,
    helpDocVersionsPurge,
    // BP32: help_submission_rate daily reset (§32.11.2 per-day semantics)
    helpSubmissionDailyReset,
    // BP35: CruiseMapper itinerary monthly refresh (§33.4)
    refreshCruisemapperItineraries,
    // BP36: CruiseMapper DIY static quarterly refresh (§33.5)
    refreshCruisemapperStatic,
    // BP40: Price-watch daily evaluator (§33.8)
    evaluatePriceWatches,
    // BP37: Tasks & follow-up (§37) — pipeline + 5 + 1 system generators
    taskSequenceStepFire,
    taskRemindersFire,
    systemTaskPassportExpiring,
    systemTaskFinalPayment,
    systemTaskQuoteExpiring,
    systemTaskPostTrip,
    systemTaskLeadAging,
    systemTaskCommissionRateMissing,
  ],
});
