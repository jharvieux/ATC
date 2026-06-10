/** Spec ref: §7.9a — Inngest serve endpoint */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { stripeWebhookIncompleteReconcile } from "@/inngest/stripe-webhook-incomplete-reconcile";
import { ragSyncRetry, ragSyncCleanup } from "@/inngest/rag-sync-retry";
import { extractMemory, extractMemoryFromBatchResult } from "@/inngest/extract-memory";
import { extractVoiceProfile } from "@/inngest/extract-voice-profile";
import { dobEstimateRepromptEligible } from "@/inngest/dob-estimate-reprompt-eligible";
import { transferFinalize } from "@/inngest/transfer-finalize";
import { reEncryptOldRecords, backupVerificationReminder } from "@/inngest/re-encrypt-old-records";
import { commissionSplitOnReceived } from "@/inngest/commission-split-on-received";
import { payoutsMarkAvailable } from "@/inngest/payouts-mark-available";
import { payoutsExecuteTransfer } from "@/inngest/payouts-execute-transfer";
import { payoutsReconcileProcessing } from "@/inngest/payouts-reconcile-processing";
import { bookingsStuckSubmittingReconcile } from "@/inngest/bookings-stuck-submitting-reconcile";
import { reconcileStatementAutomated } from "@/inngest/reconcile-statement-automated";
import { complianceNightly } from "@/inngest/compliance-nightly";
import { tenantTerminationScheduled, tenantOnTerminatedSideEffects } from "@/inngest/tenant-on-terminated";
import { tenantTerminationFinalize } from "@/inngest/tenant-termination-finalize";
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
import {
  personaAddendumScreen,
  personaAddendumScreenFromBatchResult,
} from "@/inngest/persona-addendum-screen";
import {
  personaAddendumRescreenNightly,
  personaAddendumRescreenFromBatchResult,
} from "@/inngest/persona-addendum-rescreen-nightly";
// BP34: Inbound import pipeline (§34.3) + retention sweep (§34.4)
import { importPipeline } from "@/inngest/import-pipeline";
import { purgeParsedDocuments } from "@/inngest/purge-parsed-documents";
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
import {
  ragPiiRedact,
  ragPiiRedactFromBatchResult,
  ragPiiRedactFromBatchFailure,
} from "@/inngest/rag-pii-redact";
import { ragNormalize } from "@/inngest/rag-normalize";
import { ragTenantApprovalRateNightly } from "@/inngest/rag-tenant-approval-rate-nightly";
// BP23: Email infrastructure + in-app notifications (§23)
import {
  preCruiseEmailSchedulerT1,
  preCruiseEmailSchedulerMultiphase,
} from "@/inngest/pre-cruise-email-scheduler";
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
// §26.5 — audit_log 7-year retention purge
import { auditLogRetentionPurge } from "@/inngest/audit-log-retention-purge";
// §7.9 — request_idempotency expired-row purge (hourly)
import { requestIdempotencyPurge } from "@/inngest/request-idempotency-purge";
// BP26: Vendor health probe (§26.9)
import { vendorHealthProbe } from "@/inngest/vendor-health-probe";
// #851: daily model canary — pings configured models so a retired one alerts early
import { modelCanary } from "@/inngest/model-canary";
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
// #700 — anti-abuse: suspend tenants stuck in onboarding past 14d
import { onboardingStaleSuspend } from "@/inngest/onboarding-stale-suspend";
// #692 — nightly reconcile of RAG embedding cost into tenant_usage_metrics
import { ragCostReconcile } from "@/inngest/rag-cost-reconcile";
import { weatherUsageAlert } from "@/inngest/weather-usage-alert";
import { githubIssueRetry } from "@/inngest/github-issue-retry";
import { helpDocsPdfGenerate } from "@/inngest/help-docs-pdf-generate";
import { helpDocsDocxGenerate } from "@/inngest/help-docs-docx-generate";
import { helpDocVersionsPurge } from "@/inngest/help-doc-versions-purge";
import { helpSubmissionDailyReset } from "@/inngest/help-submission-daily-reset";
// BP36 §33.5 — CruiseMapper DIY static quarterly refresh
import { refreshCruisemapperStatic } from "@/inngest/refresh-cruisemapper-static";
// #485 follow-up §33.4 — CruiseMapper sailing monthly refresh
import { refreshCruisemapperSailings } from "@/inngest/refresh-cruisemapper-sailings";
// §831 — CruiseMapper port backfill (on-demand re-enrich trigger)
import { backfillCruisemapperPorts } from "@/inngest/backfill-cruisemapper-ports";
// #828b §33.4 — derive ballpark general_pricing_ranges from interior lead-ins
import { deriveGeneralPriceRanges } from "@/inngest/derive-general-price-ranges";
// BP40 §33.8 — Price-watch daily evaluator
import { evaluatePriceWatches } from "@/inngest/evaluate-price-watches";
// BP37 §37 — Tasks: sequence step firing + reminder cron
import { taskSequenceStepFire } from "@/inngest/task-sequence-step-fire";
import { taskRemindersFire } from "@/inngest/task-reminders-fire";
// BP36 §36.6 — attribution_rollup nightly refresh
import { attributionRollupRefresh } from "@/inngest/attribution-rollup-refresh";
// §27.12 — Anthropic Message Batches integration.
import { aiBatchReconcile } from "@/inngest/ai-batch-reconcile";
import {
  aiBatchFlushPrecruise,
  aiBatchFlushMemoryExtraction,
  aiBatchFlushPersonaAddendumScreen,
  aiBatchFlushPersonaAddendumRescreen,
  aiBatchFlushRagPiiRedaction,
} from "@/inngest/ai-batch-flush";
import { precruiseSendFromBatchResult } from "@/inngest/precruise-generate-and-send";
// §TN: Travel news feed refresh
import { travelNewsRefresh } from "@/inngest/travel-news-refresh";

// When a kill switch is set, the cron-triggered functions of the deferred
// feature are excluded from registration entirely — Inngest archives them on
// the next sync, so their schedules stop firing (and stop billing executions).
// An in-handler guard alone is NOT enough: the cron would still run and bill.
// Event-driven functions of those features stay registered — idle triggers
// cost nothing, and their in-handler guards still apply.
const bookingCronsDisabled = process.env.BOOKING_CRONS_DISABLED === "true";
const subhostingCronsDisabled = process.env.SUBHOSTING_CRONS_DISABLED === "true";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    stripeWebhookIncompleteReconcile,
    ragSyncRetry,
    ragSyncCleanup,
    extractMemory,
    extractMemoryFromBatchResult,
    extractVoiceProfile,
    dobEstimateRepromptEligible,
    transferFinalize,
    reEncryptOldRecords,
    backupVerificationReminder,
    commissionSplitOnReceived,
    payoutsExecuteTransfer,
    ...(bookingCronsDisabled
      ? []
      : [
          payoutsMarkAvailable,
          payoutsReconcileProcessing,
          bookingsStuckSubmittingReconcile,
          reconcileStatementAutomated,
          preCruiseEmailSchedulerT1,
          preCruiseEmailSchedulerMultiphase,
          bookingCommissionRetentionPurge,
        ]),
    complianceNightly,
    tenantTerminationScheduled,
    tenantOnTerminatedSideEffects,
    tenantTerminationFinalize,
    ragTenantScopedPurgeOnTermination,
    userDataExportBuild,
    userDataPurgeAfterGrace,
    ccpaStagingPropagationMonitor,
    ...(subhostingCronsDisabled ? [] : [customDomainReverify, customDomainTxtGraceSweep]),
    customDomainCleanupOnSuspend,
    customDomainCleanupOnTerminated,
    customDomainCleanupOnDowngrade,
    customDomainCleanupOnTenantRemoval,
    crownJewelAnnualAudit,
    personaAddendumScreen,
    personaAddendumScreenFromBatchResult,
    personaAddendumRescreenNightly,
    personaAddendumRescreenFromBatchResult,
    // BP34: Inbound import pipeline (§34.3) + retention sweep (§34.4)
    importPipeline,
    purgeParsedDocuments,
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
    ragPiiRedactFromBatchResult,
    ragPiiRedactFromBatchFailure,
    ragNormalize,
    ragTenantApprovalRateNightly,
    // BP23: Email infrastructure + in-app notifications (§23)
    // (pre-cruise schedulers registered above under the booking kill switch)
    precruiseGenerateAndSend,
    emailSoftBounceRetry,
    // BP24: Chat UI maintenance crons (§24)
    anonymousChatCounterCleanup,
    customerChatCounterRecompute,
    denylistQuarterlyReviewReminder,
    // BP25: Retention crons (§25.2)
    anonymousSessionCleanup,
    ragRejectedItemsPurge,
    subprocessorsAnnualReview,
    // BP26: Forensics retention (§26.5a)
    forensicsLogPurgeCron,
    // §26.5 — audit_log 7-year retention purge
    auditLogRetentionPurge,
    // §7.9 — request_idempotency expired-row purge
    requestIdempotencyPurge,
    // BP26: Vendor health probe (§26.9)
    vendorHealthProbe,
    // #851: daily model canary
    modelCanary,
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
    onboardingStaleSuspend,
    ragCostReconcile,
    weatherUsageAlert,
    // BP31: Self-Service Help — GitHub issue creation resilience (§32.7.5)
    githubIssueRetry,
    // BP31 Phase C: Help docs export pipeline (§32.3.3)
    helpDocsPdfGenerate,
    helpDocsDocxGenerate,
    helpDocVersionsPurge,
    // BP32: help_submission_rate daily reset (§32.11.2 per-day semantics)
    helpSubmissionDailyReset,
    // BP36: CruiseMapper DIY static quarterly refresh (§33.5)
    refreshCruisemapperStatic,
    // #485 follow-up: CruiseMapper sailing monthly refresh
    refreshCruisemapperSailings,
    // §831: CruiseMapper port backfill (on-demand re-enrich trigger)
    backfillCruisemapperPorts,
    // #828b: derive ballpark general_pricing_ranges from interior lead-ins
    deriveGeneralPriceRanges,
    // BP40: Price-watch daily evaluator (§33.8)
    evaluatePriceWatches,
    // BP37: Tasks & follow-up (§37)
    taskSequenceStepFire,
    taskRemindersFire,
    // BP36: attribution_rollup nightly refresh (§36.6)
    attributionRollupRefresh,
    // §27.12 — AI Message Batches.
    aiBatchReconcile,
    aiBatchFlushPrecruise,
    aiBatchFlushMemoryExtraction,
    aiBatchFlushPersonaAddendumScreen,
    aiBatchFlushPersonaAddendumRescreen,
    aiBatchFlushRagPiiRedaction,
    precruiseSendFromBatchResult,
    // §TN: Travel news feed refresh (every 6h + manual trigger)
    travelNewsRefresh,
  ],
});
