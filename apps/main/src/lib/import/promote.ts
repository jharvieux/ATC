// BP34 §34.5 + §34.7 — Acceptance promotion.
//
// "Promotion" = the moment an import_queue row transitions from
// pending_review (agent click) or auto_accepted (pipeline confidence
// pass) into actual CRM records (contact / booking / commissions).
//
// This module is the single shared writer for both paths. The pipeline
// auto-accept branch calls it directly; the review-queue accept handler
// will call it after the agent confirms.
//
// Per-type behavior:
//   - lead_notification / intake_form → upsert contact only
//   - booking_confirmation            → upsert contact + create booking + write commissions
//   - commission_statement            → no promotion here; statement matching
//                                        is the §14.8 admin flow (separate path)

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/audit/write";
import { resolveCommissionRate, type ResolvedCommissionRate } from "./resolve-commission-rate";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import type {
  BookingConfirmationFields,
  IntakeFormFields,
  LeadNotificationFields,
} from "./extractors/types";

type Svc = ReturnType<typeof import("@/lib/db/service-role-client").createServiceRoleClient> &
  Pick<SupabaseClient, "from">;

export type PromoteResult =
  | { ok: true; contact_id: string; booking_id?: string; commission_id?: string }
  | { ok: false; needs_review: true; reason: "commission_rate_missing" | "unsupported_document_type" }
  | { ok: false; error: string };

// #1576 — the resting states a row may be CAS-claimed FROM: the review-queue
// accept route arrives at 'pending_review', the pipeline auto-accept path at
// 'pending_validation'.
const PROMOTE_CLAIMABLE_STATUSES = ["pending_review", "pending_validation"] as const;

const PROMOTABLE_DOCUMENT_TYPES = new Set(["lead_notification", "intake_form", "booking_confirmation"]);

type QueueRow = {
  id: string;
  tenant_id: string;
  import_path: "email" | "document" | "manual";
  source_ref: string;
  document_type: string | null;
  raw_extracted_fields: unknown;
  extraction_overall_confidence: number | null;
  submitted_by_user_id: string | null;
  status: string;
  promoted_contact_id: string | null;
  promoted_booking_id: string | null;
};

export async function promoteImport(args: {
  queue_row_id: string;
  svc: Svc;
  // Caller supplies the host-adapter rate lookup if available. Falls
  // through to agent input per §34.7.3 step 3 when undefined.
  getAdapterRate?: ((cruise_line: string | null) => Promise<number | null>) | undefined;
  acceptingUserId?: string | null | undefined;
  // #1576 — when true, a row already in 'promoting' is treated as a resumable
  // in-flight promotion (re-drive from the checkpoints) rather than a
  // concurrent conflict. The Inngest auto-accept path sets this: its whole-step
  // retries are sequential (one run per row + the pipeline's status guard), so
  // re-entering is always the same logical execution finishing its work. The
  // HTTP accept route leaves it false — a second concurrent click must 409, not
  // race the first.
  resumeInProgress?: boolean;
}): Promise<PromoteResult> {
  const { queue_row_id, svc, getAdapterRate, acceptingUserId, resumeInProgress = false } = args;

  const { data: rowData, error: loadErr } = await svc
    .from("import_queue")
    .select("id, tenant_id, import_path, source_ref, document_type, raw_extracted_fields, extraction_overall_confidence, submitted_by_user_id, status, promoted_contact_id, promoted_booking_id")
    .eq("id", queue_row_id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: `load_queue_row_failed: ${loadErr.message}` };
  if (!rowData) return { ok: false, error: "queue_row_not_found" };

  const row = rowData as QueueRow;
  const { document_type } = row;

  // commission_statement is handled by §14.8 statement-matching, not here — and
  // never claims a promote slot.
  if (!document_type || !PROMOTABLE_DOCUMENT_TYPES.has(document_type)) {
    return { ok: false, needs_review: true, reason: "unsupported_document_type" };
  }

  // #1576 — CAS-claim the row before ANY write. Exactly one caller flips
  // pending_review|pending_validation → promoting; every other concurrent
  // caller and every post-inserts retry sees zero rows here and is routed by
  // the row's live status instead of blindly re-running the 5 writes (which
  // duplicated contact + booking + commission → double payout).
  const claim = await claimForPromotion(svc, row, resumeInProgress);
  if (claim === "already_accepted") {
    // Idempotent: a prior promotion already finished. Return its records.
    return row.promoted_contact_id
      ? {
          ok: true,
          contact_id: row.promoted_contact_id,
          ...(row.promoted_booking_id ? { booking_id: row.promoted_booking_id } : {}),
        }
      : { ok: false, error: "already_accepted_without_promoted_contact" };
  }
  if (claim === "in_progress") return { ok: false, error: "promotion_in_progress" };
  if (claim === "not_promotable") return { ok: false, error: `not_promotable_status:${row.status}` };
  // claim is "claimed" (fresh) or "resumed" (re-drive from row.promoted_*).

  const result =
    document_type === "booking_confirmation"
      ? await promoteBooking(svc, row, row.raw_extracted_fields as BookingConfirmationFields, getAdapterRate, acceptingUserId)
      : await promoteLeadOrIntake(
          svc,
          row,
          row.raw_extracted_fields as LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] },
          acceptingUserId,
        );

  // A genuine failure AFTER claiming (not a needs_review re-park, which already
  // reset the status itself) must release the claim so the row is retryable.
  // The promoted_contact_id/booking_id checkpoints persist, so the next attempt
  // re-drives idempotently rather than duplicating.
  if (!result.ok && !("needs_review" in result)) {
    await safeAwait(
      svc
        .from("import_queue")
        // d091-allow:cas-rowcount best-effort claim release; a zero-row no-op is correct when the row was already finalized/reset elsewhere
        .update({ status: "pending_review" })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .eq("status", "promoting"),
      "import_queue.unclaim_promotion",
    );
  }
  return result;
}

// Returns how the claim resolved. "claimed" = we flipped the row to promoting;
// "resumed" = it was already promoting and the caller opted to re-drive;
// "already_accepted" = a prior promotion finished; "in_progress" = someone else
// holds it and the caller won't resume; "not_promotable" = wrong state.
async function claimForPromotion(
  svc: Svc,
  row: QueueRow,
  resumeInProgress: boolean,
): Promise<"claimed" | "resumed" | "already_accepted" | "in_progress" | "not_promotable"> {
  const claimed =
    (await safeAwait(
      svc
        .from("import_queue")
        .update({ status: "promoting" })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .in("status", PROMOTE_CLAIMABLE_STATUSES as unknown as string[])
        .select("id"),
      "import_queue.claim_promotion",
    )) ?? [];
  if ((claimed as unknown[]).length === 1) return "claimed";

  // Zero rows claimed — decide by the row's live status.
  const { data: cur, error } = await svc
    .from("import_queue")
    .select("status")
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id)
    .maybeSingle();
  if (error) throw new Error(`claim_promotion_reread_failed: ${error.message}`);
  const status = (cur as { status?: string } | null)?.status;
  if (status === "accepted") return "already_accepted";
  if (status === "promoting") return resumeInProgress ? "resumed" : "in_progress";
  return "not_promotable";
}

// ── lead / intake ────────────────────────────────────────────────────────

async function promoteLeadOrIntake(
  svc: Svc,
  row: QueueRow,
  fields: LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] },
  acceptingUserId: string | null | undefined,
): Promise<PromoteResult> {
  // #1576 — reuse the checkpoint on a resumed promotion; only insert on a
  // fresh claim. Keeps the contact exactly-once across a mid-sequence retry.
  const contactId = await ensureContact(svc, row, {
    contact_name: fields.contact_name ?? null,
    contact_email: fields.contact_email ?? null,
    contact_phone: fields.contact_phone ?? null,
    notes: buildLeadNotes(fields),
  });
  if (!contactId.ok) return { ok: false, error: contactId.error };

  await writeContactImportRow(svc, row, contactId.id, acceptingUserId);
  await finalizeQueueRowAccepted(svc, row.id, contactId.id, null);
  await writeAuditLog({
    tenant_id: row.tenant_id,
    actor_user_id: acceptingUserId ?? null,
    actor_type: acceptingUserId ? "user" : "system",
    action: "import.accepted",
    resource_type: "import_queue",
    resource_id: row.id,
    context: {
      document_type: row.document_type,
      promoted_contact_id: contactId.id,
      confidence: row.extraction_overall_confidence,
    },
  });
  return { ok: true, contact_id: contactId.id };
}

function buildLeadNotes(f: LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] }): string | null {
  const parts: string[] = [];
  if (f.interest_summary) parts.push(`Interest: ${f.interest_summary}`);
  if (f.destination) parts.push(`Destination: ${f.destination}`);
  if (f.travel_window) parts.push(`Window: ${f.travel_window}`);
  if (f.party_size) parts.push(`Party size: ${f.party_size}`);
  if (f.preferences && Object.keys(f.preferences).length > 0) {
    for (const [k, v] of Object.entries(f.preferences)) {
      if (v !== null && v !== undefined && v !== "") parts.push(`${k}: ${String(v)}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// ── booking ──────────────────────────────────────────────────────────────

async function promoteBooking(
  svc: Svc,
  row: QueueRow,
  fields: BookingConfirmationFields,
  getAdapterRate: ((cruise_line: string | null) => Promise<number | null>) | undefined,
  acceptingUserId: string | null | undefined,
): Promise<PromoteResult> {
  // §34.7.4 / §34.9 — sub-host tenants cannot import bookings (the
  // platform is host-of-record for sub-hosts, so all sub-host bookings
  // flow through the platform's booking flow by definition). Block here
  // before any writes happen.
  const { data: tenantData } = await svc
    .from("tenants")
    .select("tenant_type")
    .eq("id", row.tenant_id)
    .maybeSingle();
  const tenantType = (tenantData as { tenant_type?: string } | null)?.tenant_type;
  if (tenantType && tenantType !== "byo_host") {
    return {
      ok: false,
      error: `booking_import_not_permitted_for_tenant_type:${tenantType}`,
    };
  }

  // §34.7.3 rate resolution. If null → can't promote; row stays in review.
  // Resets the CAS-claimed 'promoting' back to pending_review (un-claim) so the
  // agent can re-accept once a rate is supplied.
  const rate = await resolveCommissionRate({
    tenant_id: row.tenant_id,
    fields,
    getAdapterRate,
  });
  if (!rate) {
    await safeAwait(svc
      .from("import_queue")
      .update({
        status: "pending_review",
        parse_failure_reason: "commission_rate_missing",
      })
      .eq("id", row.id), "import_queue.update");
    return { ok: false, needs_review: true, reason: "commission_rate_missing" };
  }

  // Contact from the first passenger last name if we don't have an email/phone.
  // #1576 — email/phone are null here, so the DB unique guards don't cover this
  // insert; the checkpoint reuse (via ensureContact) is what keeps it
  // exactly-once across a retry.
  const primaryLastName = fields.passenger_last_names[0] ?? null;
  const contact = await ensureContact(svc, row, {
    contact_name: primaryLastName ?? "(imported booking)",
    contact_email: null,
    contact_phone: null,
    notes: `Imported booking: ${fields.cruise_line ?? "?"} / ${fields.ship_name ?? "?"} on ${fields.sailing_date ?? "?"}`,
  });
  if (!contact.ok) return { ok: false, error: contact.error };

  const bookingId = await ensureBooking(svc, row, fields, contact.id, acceptingUserId);
  if (!bookingId.ok) return { ok: false, error: bookingId.error };

  const commissionId = await ensureCommission(svc, row, fields, bookingId.id, rate);
  if (!commissionId.ok) return { ok: false, error: commissionId.error };

  await writeContactImportRow(svc, row, contact.id, acceptingUserId);
  await finalizeQueueRowAccepted(svc, row.id, contact.id, bookingId.id);
  await writeAuditLog({
    tenant_id: row.tenant_id,
    actor_user_id: acceptingUserId ?? null,
    actor_type: acceptingUserId ? "user" : "system",
    action: "import.accepted",
    resource_type: "import_queue",
    resource_id: row.id,
    context: {
      document_type: "booking_confirmation",
      promoted_contact_id: contact.id,
      promoted_booking_id: bookingId.id,
      commission_rate: rate.rate,
      commission_rate_source: rate.source,
      confidence: row.extraction_overall_confidence,
    },
  });

  return { ok: true, contact_id: contact.id, booking_id: bookingId.id, commission_id: commissionId.id };
}

// ── contact upsert ───────────────────────────────────────────────────────

async function upsertContact(
  svc: Svc,
  row: QueueRow,
  args: {
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    notes: string | null;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // §34.3.4 dedupe on (tenant_id, email) or (tenant_id, phone).
  if (args.contact_email) {
    const { data } = await svc
      .from("contacts")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("email", args.contact_email)
      .maybeSingle();
    if ((data as { id?: string } | null)?.id) return { ok: true, id: (data as { id: string }).id };
  }
  if (args.contact_phone) {
    const { data } = await svc
      .from("contacts")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("phone", args.contact_phone)
      .maybeSingle();
    if ((data as { id?: string } | null)?.id) return { ok: true, id: (data as { id: string }).id };
  }

  const [first_name, ...rest] = (args.contact_name ?? "").trim().split(/\s+/);
  const last_name = rest.length > 0 ? rest.join(" ") : null;

  const sourceRef = `${row.import_path}:${row.source_ref}`;
  const { data, error } = await svc
    .from("contacts")
    .insert({
      tenant_id: row.tenant_id,
      first_name: first_name || null,
      last_name,
      email: args.contact_email,
      phone: args.contact_phone,
      source: "imported",
      source_reference: sourceRef,
      notes: args.notes,
    })
    .select("id")
    .single();
  if (error) {
    // #1576 — a concurrent promote won the (tenant_id, lower(email)) unique
    // index (#1630) between our lookup and insert. Treat as already-created and
    // adopt the existing contact rather than erroring.
    if (error.code === "23505" && args.contact_email) {
      const { data: existing } = await svc
        .from("contacts")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .eq("email", args.contact_email)
        .maybeSingle();
      const existingId = (existing as { id?: string } | null)?.id;
      if (existingId) return { ok: true, id: existingId };
    }
    return { ok: false, error: `contact_insert_failed: ${error.message}` };
  }
  return { ok: true, id: (data as { id: string }).id };
}

// ── idempotent write wrappers (#1576) ────────────────────────────────────────
// Each reuses the checkpoint the queue row carries from a prior partial run, so
// a mid-sequence-failure retry re-drives to completion without duplicating.

async function ensureContact(
  svc: Svc,
  row: QueueRow,
  args: { contact_name: string | null; contact_email: string | null; contact_phone: string | null; notes: string | null },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (row.promoted_contact_id) return { ok: true, id: row.promoted_contact_id };
  const contact = await upsertContact(svc, row, args);
  if (!contact.ok) return contact;
  await checkpoint(svc, row, { promoted_contact_id: contact.id });
  return contact;
}

async function ensureBooking(
  svc: Svc,
  row: QueueRow,
  fields: BookingConfirmationFields,
  contactId: string,
  acceptingUserId: string | null | undefined,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (row.promoted_booking_id) return { ok: true, id: row.promoted_booking_id };
  const booking = await insertImportedBooking(svc, row, fields, contactId, acceptingUserId);
  if (!booking.ok) return booking;
  await checkpoint(svc, row, { promoted_booking_id: booking.id });
  return booking;
}

// Persist a produced record id onto the queue row immediately so a retry after
// a later-step failure reuses it instead of inserting a duplicate.
async function checkpoint(
  svc: Svc,
  row: QueueRow,
  patch: { promoted_contact_id?: string; promoted_booking_id?: string },
): Promise<void> {
  await safeAwait(
    svc.from("import_queue").update(patch).eq("id", row.id).eq("tenant_id", row.tenant_id),
    "import_queue.checkpoint_promoted_ids",
  );
}

// ── booking + commissions inserts ────────────────────────────────────────

async function insertImportedBooking(
  svc: Svc,
  row: QueueRow,
  fields: BookingConfirmationFields,
  contactId: string,
  acceptingUserId: string | null | undefined,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const [lineRes, shipRes] = await Promise.all([
    resolveCanonical(fields.cruise_line, "line", svc),
    resolveCanonical(fields.ship_name, "ship", svc),
  ]);

  const { data, error } = await svc
    .from("bookings")
    .insert({
      tenant_id: row.tenant_id,
      primary_contact_id: contactId,
      booking_type: "cruise",
      cruise_line: fields.cruise_line,
      ship_name: fields.ship_name,
      sailing_date: fields.sailing_date,
      duration_nights: fields.duration_nights,
      departure_port: fields.departure_port,
      cabin_category: fields.cabin_category,
      // Invariant: *_cents fields hold the amount in `currency`'s own ISO-4217 minor unit
      // (Stripe convention) — never ×100-scaled. formatCents() derives the divisor from the
      // paired currency, so zero-decimal codes (JPY) must not be re-scaled here (#1658).
      total_amount_cents: fields.total_amount_cents,
      commissionable_fare_cents: fields.total_amount_cents, // §34: defaults to total if no breakout
      currency: fields.currency ?? "USD",
      // BP34 Phase A fields:
      origin: "imported",
      imported_from: row.import_path,
      imported_at: new Date().toISOString(),
      imported_by_user_id: acceptingUserId ?? null,
      provider_booking_ref: fields.provider_booking_ref,
      status: "confirmed",
      ...(lineRes.matched && { cruise_line_id: lineRes.id }),
      ...(shipRes.matched && { cruise_ship_id: shipRes.id }),
    })
    .select("id")
    .single();
  if (error) {
    // #1576 — concurrent promote won the (tenant_id, provider_booking_ref)
    // imported-booking unique index (#1630). Adopt the existing row.
    if (error.code === "23505" && fields.provider_booking_ref) {
      const { data: existing } = await svc
        .from("bookings")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .eq("provider_booking_ref", fields.provider_booking_ref)
        .eq("origin", "imported")
        .maybeSingle();
      const existingId = (existing as { id?: string } | null)?.id;
      if (existingId) return { ok: true, id: existingId };
    }
    return { ok: false, error: `booking_insert_failed: ${error.message}` };
  }
  return { ok: true, id: (data as { id: string }).id };
}

// §34.7.2 — one commission row per booking (commissions.booking_id is UNIQUE,
// #1630). #1576 — look up first, then insert, and treat a 23505 race as
// already-created. This is the innermost guard against the double-payout: even
// if two executions reach here, exactly one commission row can exist per
// booking, so the payout pipeline can never see two.
async function ensureCommission(
  svc: Svc,
  row: QueueRow,
  fields: BookingConfirmationFields,
  bookingId: string,
  rate: ResolvedCommissionRate,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data: existing } = await svc
    .from("commissions")
    .select("id")
    .eq("tenant_id", row.tenant_id)
    .eq("booking_id", bookingId)
    .maybeSingle();
  const existingId = (existing as { id?: string } | null)?.id;
  if (existingId) return { ok: true, id: existingId };

  // §34.7.4: platform_split_rate is NULL for BYO; default 0 here. Sub-host
  // imports are not permitted in v1 per §34.9, so 0 holds the invariant.
  // Same money invariant as the booking insert: every *_cents value below is in
  // `currency`'s ISO-4217 minor unit, not ×100-scaled — don't reintroduce scaling (#1658).
  const commissionable = fields.total_amount_cents ?? 0;
  const gross = Math.round(commissionable * rate.rate);

  const { data, error } = await svc
    .from("commissions")
    .insert({
      tenant_id: row.tenant_id,
      booking_id: bookingId,
      commissionable_fare_cents: commissionable,
      commission_rate: rate.rate,
      platform_split_rate: 0,
      gross_commission_cents: gross,
      host_booking_fee_cents: 0,
      net_commission_cents: gross,
      platform_retained_cents: 0,
      subhost_payable_cents: 0,
      currency: fields.currency ?? "USD",
      status: "expected",
      commission_rate_source: rate.source,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: race } = await svc
        .from("commissions")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .eq("booking_id", bookingId)
        .maybeSingle();
      const raceId = (race as { id?: string } | null)?.id;
      if (raceId) return { ok: true, id: raceId };
    }
    return { ok: false, error: `commission_insert_failed: ${error.message}` };
  }
  return { ok: true, id: (data as { id: string }).id };
}

// ── audit trail + queue finalization ─────────────────────────────────────

async function writeContactImportRow(
  svc: Svc,
  row: QueueRow,
  contactId: string,
  acceptingUserId: string | null | undefined,
): Promise<void> {
  // #1576 — skip if this import already recorded its audit row (re-drive after
  // a later-step failure). contact_imports has no unique constraint, so this
  // lookup-first is the dedup.
  const existing =
    (await safeAwait(
      svc
        .from("contact_imports")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .eq("contact_id", contactId)
        .eq("source_ref", row.source_ref)
        .limit(1),
      "contact_imports.dedup_check",
    )) ?? [];
  if ((existing as unknown[]).length > 0) return;

  await safeAwait(svc.from("contact_imports").insert({
    tenant_id: row.tenant_id,
    contact_id: contactId,
    import_path: row.import_path,
    source_ref: row.source_ref,
    document_type: row.document_type ?? "unknown",
    confidence: row.extraction_overall_confidence,
    imported_by_user_id: acceptingUserId ?? row.submitted_by_user_id ?? null,
    raw_extracted_fields: row.raw_extracted_fields ?? null,
  }), "contact_imports.insert");
}

async function finalizeQueueRowAccepted(
  svc: Svc,
  queueRowId: string,
  contactId: string,
  bookingId: string | null,
): Promise<void> {
  // §34.4 — 24-hour retention on accepted rows; purge cron sweeps after.
  const purgable_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await safeAwait(svc
    .from("import_queue")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      promoted_contact_id: contactId,
      promoted_booking_id: bookingId,
      purgable_at,
    })
    .eq("id", queueRowId), "import_queue.update");
}
