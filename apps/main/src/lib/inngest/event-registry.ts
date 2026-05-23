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
  "tenant.subscription_changed": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "tenant.custom_domain_removed_by_lifecycle": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

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

  // CCPA / user data (BP17, BP25)
  "user.data_export_requested": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
  "user.data_purge_scheduled": { kind: "tenant_scoped", payload_shape: tenantScopedShape },

  // Abuse + cost monitoring (BP27)
  "abuse.state_transition": { kind: "tenant_scoped", payload_shape: tenantScopedShape },
};

// Silence the unused-variable warning until a platform_admin event ships.
void platformAdminShape;

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
