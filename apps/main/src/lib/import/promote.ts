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

type QueueRow = {
  id: string;
  tenant_id: string;
  import_path: "email" | "document" | "manual";
  source_ref: string;
  document_type: string | null;
  raw_extracted_fields: unknown;
  extraction_overall_confidence: number | null;
  submitted_by_user_id: string | null;
};

export async function promoteImport(args: {
  queue_row_id: string;
  svc: Svc;
  // Caller supplies the host-adapter rate lookup if available. Falls
  // through to agent input per §34.7.3 step 3 when undefined.
  getAdapterRate?: ((cruise_line: string | null) => Promise<number | null>) | undefined;
  acceptingUserId?: string | null | undefined;
}): Promise<PromoteResult> {
  const { queue_row_id, svc, getAdapterRate, acceptingUserId } = args;

  const { data: rowData, error: loadErr } = await svc
    .from("import_queue")
    .select("id, tenant_id, import_path, source_ref, document_type, raw_extracted_fields, extraction_overall_confidence, submitted_by_user_id")
    .eq("id", queue_row_id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: `load_queue_row_failed: ${loadErr.message}` };
  if (!rowData) return { ok: false, error: "queue_row_not_found" };

  const row = rowData as QueueRow;
  const { document_type } = row;

  switch (document_type) {
    case "lead_notification":
      return promoteLeadOrIntake(svc, row, row.raw_extracted_fields as LeadNotificationFields, acceptingUserId);
    case "intake_form":
      return promoteLeadOrIntake(svc, row, row.raw_extracted_fields as unknown as LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] }, acceptingUserId);
    case "booking_confirmation":
      return promoteBooking(svc, row, row.raw_extracted_fields as BookingConfirmationFields, getAdapterRate, acceptingUserId);
    default:
      // commission_statement is handled by §14.8 statement-matching, not here.
      return { ok: false, needs_review: true, reason: "unsupported_document_type" };
  }
}

// ── lead / intake ────────────────────────────────────────────────────────

async function promoteLeadOrIntake(
  svc: Svc,
  row: QueueRow,
  fields: LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] },
  acceptingUserId: string | null | undefined,
): Promise<PromoteResult> {
  const contact = await upsertContact(svc, row, {
    contact_name: fields.contact_name ?? null,
    contact_email: fields.contact_email ?? null,
    contact_phone: fields.contact_phone ?? null,
    notes: buildLeadNotes(fields),
  });
  if (!contact.ok) return { ok: false, error: contact.error };

  await writeContactImportRow(svc, row, contact.id, acceptingUserId);
  await finalizeQueueRowAccepted(svc, row.id, contact.id, null);
  await writeAuditLog({
    tenant_id: row.tenant_id,
    actor_user_id: acceptingUserId ?? null,
    actor_type: acceptingUserId ? "user" : "system",
    action: "import.accepted",
    resource_type: "import_queue",
    resource_id: row.id,
    context: {
      document_type: row.document_type,
      promoted_contact_id: contact.id,
      confidence: row.extraction_overall_confidence,
    },
  });
  return { ok: true, contact_id: contact.id };
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
  const primaryLastName = fields.passenger_last_names[0] ?? null;
  const contact = await upsertContact(svc, row, {
    contact_name: primaryLastName ?? "(imported booking)",
    contact_email: null,
    contact_phone: null,
    notes: `Imported booking: ${fields.cruise_line ?? "?"} / ${fields.ship_name ?? "?"} on ${fields.sailing_date ?? "?"}`,
  });
  if (!contact.ok) return { ok: false, error: contact.error };

  const bookingId = await insertImportedBooking(svc, row, fields, contact.id, acceptingUserId);
  if (!bookingId.ok) return { ok: false, error: bookingId.error };

  const commissionId = await insertImportedCommission(svc, row, fields, bookingId.id, rate);
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
  if (error) return { ok: false, error: `contact_insert_failed: ${error.message}` };
  return { ok: true, id: (data as { id: string }).id };
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
  if (error) return { ok: false, error: `booking_insert_failed: ${error.message}` };
  return { ok: true, id: (data as { id: string }).id };
}

async function insertImportedCommission(
  svc: Svc,
  row: QueueRow,
  fields: BookingConfirmationFields,
  bookingId: string,
  rate: ResolvedCommissionRate,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // §34.7.2 — commissions row written at import-acceptance time. §34.7.4:
  // platform_split_rate is NULL for BYO; we default to 0 here and let the
  // promotion caller (or a follow-up tier-aware tweak) set it explicitly
  // when sub-host imports are added in a future build. Sub-host imports
  // are not permitted in v1 per §34.9 so 0 is correct for the
  // BYO-only-imports invariant of this phase.
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
  if (error) return { ok: false, error: `commission_insert_failed: ${error.message}` };
  return { ok: true, id: (data as { id: string }).id };
}

// ── audit trail + queue finalization ─────────────────────────────────────

async function writeContactImportRow(
  svc: Svc,
  row: QueueRow,
  contactId: string,
  acceptingUserId: string | null | undefined,
): Promise<void> {
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
