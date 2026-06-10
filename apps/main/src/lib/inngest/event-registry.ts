// §26.3a.4 — Inngest event registry.
//
// Single source of truth for every event name the platform emits or
// consumes. Every Inngest function MUST call validateInngestEvent(event)
// at the top of its handler to assert the event name is registered and
// the payload shape matches.
//
// Tenant-scoped events MUST carry payload.tenant_id (string). Platform-
// admin events do not require tenant_id; the consuming function must be
// wrapped in withPlatformAdminAudit (enforced at runtime via the ALS
// check on platformAdminClient).
//
// To add a new event: append an entry below. The narrow per-event payload
// shapes are intentionally loose (`z.passthrough()`) — tightening to
// exact payload schemas is a follow-on hardening pass.

import { z } from "zod";

const tenantScopedShape = z
  .object({ tenant_id: z.string() })
  .passthrough();

const platformAdminShape = z.object({}).passthrough();

export type EventKind = "tenant_scoped" | "platform_admin";

export interface RegisteredEvent {
  kind: EventKind;
  payload_shape: z.ZodTypeAny;
}

// Seeded by sweeping `name:` literals across src/inngest, src/lib, and
// src/app. See MEMORY D-059 for the seeding audit.
export const EVENT_REGISTRY: Record<string, RegisteredEvent> = {
  // Tenant lifecycle
  "tenant.activated": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.submitted_for_review": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.termination_scheduled": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.terminated": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.suspended": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.subscription_changed": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.custom_domain_removed_by_lifecycle": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Commission lifecycle (BP15)
  "commission/state_received": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Encryption key rotation (BP14)
  "admin/reencrypt_credentials_started": { kind: "platform_admin", payload_shape: platformAdminShape },

  // Customer memory + transfer (BP12/13)
  "conversation.memory_extract_requested": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "anonymous_session.transfer_finalize": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Forums (BP20)
  "forum/message.needs_moderation_retry": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // RAG ingestion (BP22)
  "rag.submission_needs_extraction": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "rag.submission_ready_for_pii_redaction": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "rag.submission_ready_for_normalization": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.rag_pii_recurring_pattern_detected": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.rag_submission_rejected": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Email (BP23)
  "precruise/email.due": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "email/soft.bounce.retry": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "resend.webhook": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Chat (BP24)
  "chat.anonymous_chat_burst_detected": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Persona addendums (BP18)
  "persona_addendum.submitted": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // §27.12 — AI Message Batches per-row completion + failure events.
  // Reconciler emits one event per row when its batch result lands.
  "ai.batch_request.completed.memory_extraction":         { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "ai.batch_request.completed.persona_addendum_screen":   { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "ai.batch_request.completed.persona_addendum_rescreen": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "ai.batch_request.completed.precruise_generation":      { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "ai.batch_request.completed.rag_pii_redaction":         { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  // Failure variant — currently consumed by rag_pii_redaction (which
  // quarantines on failure). Other surfaces let Inngest retry naturally.
  "ai.batch_request.failed.rag_pii_redaction":            { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // BP34 §34.3 — inbound import pipeline
  "import.queued": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  // BP37 §37.4.2 — task sequence step scheduled (consumed by task-sequence-step-fire).
  "task_sequence.step_scheduled": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // CCPA / user data (BP17, BP25)
  "user.data_export_requested": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "user.data_purge_scheduled": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Abuse + cost monitoring (BP27)
  "abuse.state_transition": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Self-Service Help (BP31 §32)
  "help.session_opened":               { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.session_closed":               { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.bug_submitted":                { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.feature_submitted":            { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.github_issue_creation_failed": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  // BP31 Phase C — help-docs export pipeline (§32.3.3)
  "help/docs.export.pdf":              { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help/docs.export.docx":             { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  // BP32 §32.10 / §32.10.7 — customer bug flow + GitHub closure recording
  "help.customer_bug_triggered":       { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.customer_bug_completed":       { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "help.issue_closed":                 { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // #903 — Voice-profile extraction (D-193 Phase 2, BYO dual-role personas).
  // Event-driven; no cron (idle = free, consistent with D-192 cost posture).
  "voice_profile.extraction_requested": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // §23.4 — Open-Meteo rate-limit gate. Emitted when today's request
  // counter is at-or-over the configured daily cap. Consumed by the
  // operator-alert function (PR B).
  "platform.weather_rate_limit_hit":   { kind: "platform_admin", payload_shape: platformAdminShape },

  // §831 — CruiseMapper port backfill (on-demand re-enrich trigger).
  // Optional data.ship_urls narrows to a subset; defaults to full inventory.
  "cruisemapper/port-backfill.requested": { kind: "platform_admin", payload_shape: platformAdminShape },
};

export class EventNotRegisteredError extends Error {
  constructor(name: string) {
    super(`Inngest event '${name}' is not in the registry. Add it to lib/inngest/event-registry.ts.`);
  }
}

export class EventPayloadInvalidError extends Error {
  constructor(name: string, issues: string) {
    super(`Inngest event '${name}' payload failed validation: ${issues}`);
  }
}

/**
 * Asserts the event name is registered and the payload matches the
 * registered shape. Call this at the top of every Inngest function
 * handler. Throws on failure.
 */
export function validateInngestEvent(
  name: string,
  payload: unknown,
): void {
  const entry = EVENT_REGISTRY[name];
  if (!entry) throw new EventNotRegisteredError(name);
  const result = entry.payload_shape.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new EventPayloadInvalidError(name, issues);
  }
}

export function isPlatformAdminEvent(name: string): boolean {
  return EVENT_REGISTRY[name]?.kind === "platform_admin";
}
