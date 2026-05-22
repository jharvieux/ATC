// Inngest event type registry for atc-main.
//
// All events emitted or consumed by Inngest functions in this app are declared
// here. The event name is the discriminant; each entry describes the payload
// shape so TypeScript enforces it at call sites.

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
};
