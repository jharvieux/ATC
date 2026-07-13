// Inngest event type registry for atc-main.
//
// All events emitted or consumed by Inngest functions in this app are declared
// here. The event name is the discriminant; each entry describes the payload
// shape so TypeScript enforces it at call sites.

import type { TenantEvent, PlatformEvent } from "@atc/contracts";

export interface ConversationMemoryExtractRequestedPayload {
  tenant_id: string;
  conversation_id: string;
  user_id: string;
}

export interface AnonymousSessionTransferFinalizePayload {
  tenant_id: string;
  anonymous_session_id: string;
  user_id: string;
}

// dob_reprompt.eligible_check carries no payload — it's cron-driven.
export interface DobRepromptEligibleCheckPayload {}

// §15.10 — Tenant submitted for admin review.
export interface TenantSubmittedForReviewPayload {
  tenant_id: string;
}

// §15.11 — Tenant approved and activated.
export interface TenantActivatedPayload {
  tenant_id: string;
  admin_user_id: string;
}

// §15.15 — Subscription changed (tier, seats, or billing period).
export interface TenantSubscriptionChangedPayload {
  tenant_id: string;
  change: "tier" | "seats" | "billing_period";
  new_tier?: string;
  new_seat_count?: number;
  new_billing_period?: string;
}

// §15.14.1 — Tenant termination scheduled (voluntary or involuntary).
export interface TenantTerminationScheduledPayload {
  tenant_id: string;
  kind: "voluntary" | "involuntary_content" | "involuntary_other";
  terminate_at: string;
  admin_user_id: string;
}

// §15.14.2 — Tenant fully terminated (triggers side-effects).
export interface TenantTerminatedPayload {
  tenant_id: string;
  kind: "voluntary" | "involuntary_content" | "involuntary_other";
}

// §17.9 — CCPA data export requested.
export interface UserDataExportRequestedPayload {
  auth_user_id: string;
  export_request_id: string;
}

// §17.10 — CCPA data purge scheduled (after 30-day grace period).
export interface UserDataPurgeScheduledPayload {
  auth_user_id: string;
  user_id: string;
  deleted_at: string;
  purge_at: string;
}

export type InngestEvents = {
  "conversation.memory_extract_requested": {
    data: ConversationMemoryExtractRequestedPayload;
  };
  "anonymous_session.transfer_finalize": {
    data: AnonymousSessionTransferFinalizePayload;
  };
  "dob_reprompt.eligible_check": {
    data: DobRepromptEligibleCheckPayload;
  };
  "tenant.submitted_for_review": {
    data: TenantSubmittedForReviewPayload;
  };
  "tenant.activated": {
    data: TenantActivatedPayload;
  };
  "tenant.subscription_changed": {
    data: TenantSubscriptionChangedPayload;
  };
  "tenant.termination_scheduled": {
    data: TenantTerminationScheduledPayload;
  };
  "tenant.terminated": {
    data: TenantTerminatedPayload;
  };
  "tenant.custom_domain_removed_by_lifecycle": {
    data: { tenant_id: string; reason: string };
  };
  "user.data_export_requested": {
    data: UserDataExportRequestedPayload;
  };
  "user.data_purge_scheduled": {
    data: UserDataPurgeScheduledPayload;
  };
  // §15.14.2 / §16.3.3 — lifecycle events that trigger custom-domain unbind.
  "tenant.suspended": {
    data: { tenant_id: string };
  };
  "tenant.downgraded_from_agency": {
    data: { tenant_id: string };
  };
  "tenant.custom_domain_removed_by_tenant": {
    data: { tenant_id: string };
  };
  // §16.6 — persona addendum submitted (initial or edit), triggers Haiku screen.
  "persona_addendum.submitted": {
    data: { tenant_id: string; persona_slug: string; addendum_id: string };
  };
  // #781 Phase 2 Step 2 — on-demand backfill of cruise_line_id / cruise_ship_id FKs.
  "cruise.fk_backfill_requested": {
    data: { tables?: Array<"quote_options" | "bookings" | "groups" | "price_watches"> };
  };
  // §34.3 — Inbound import queued for processing (email, document, or manual).
  "import.queued": {
    data: { tenant_id: string; import_queue_id: string };
  };
  // §37.4.2 — sequence step scheduled to fire after a delay. Consumed by
  // the task_sequence_step_fire Inngest function which materializes the
  // task and any reminders from the snapshot.
  "task_sequence.step_scheduled": {
    data: {
      tenant_id: string;
      sequence_run_id: string;
      step_index: number;
    };
  };
  // §8.7 / §8.7a (#1609) — RAG-sync delivery moved off the in-request retry
  // sleeps + pending_rag_sync cron onto Inngest. Publishers enqueue; the
  // rag-sync-deliver function owns delivery with Inngest-managed retries.
  "rag-sync/tenant.event": {
    data: { event: TenantEvent };
  };
  "rag-sync/platform.event": {
    data: { event: PlatformEvent };
  };
};
