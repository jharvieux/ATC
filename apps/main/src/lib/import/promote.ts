// BP34 §34.5 + §34.7 — Acceptance promotion.
//
// "Promotion" = the moment an import_queue row transitions from
// pending_review (agent click) or pending_validation (pipeline confidence
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
//
// #1712 (folds in #1711) — the claim → contact/booking/commission inserts →
// contact_imports → finalize sequence runs inside ONE atomic Postgres RPC
// (public.promote_import). This module resolves everything that needs I/O or
// business logic outside a transaction (sub-host block, commission-rate
// resolution, canonical line/ship resolution, contact-name split) and feeds the
// resolved scalars into the RPC, which does all the writes atomically. There is
// no intermediate 'promoting' state and no per-step checkpoint reasoning: either
// the whole promote commits or nothing does, so a mid-sequence crash can no
// longer orphan a duplicate contact/booking (#1711). A concurrent second accept
// blocks on the RPC's SELECT … FOR UPDATE, then returns the already-promoted ids.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/audit/write";
import { resolveCommissionRate } from "./resolve-commission-rate";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import type {
  BookingConfirmationFields,
  IntakeFormFields,
  LeadNotificationFields,
} from "./extractors/types";

type Svc = ReturnType<typeof import("@/lib/db/service-role-client").createServiceRoleClient> &
  Pick<SupabaseClient, "from" | "rpc">;

export type PromoteResult =
  | { ok: true; status: "promoted" | "already_accepted"; contact_id: string; booking_id?: string; commission_id?: string }
  | { ok: false; needs_review: true; reason: "commission_rate_missing" | "unsupported_document_type" }
  | { ok: false; error: string };

// #1576 — the resting states a row may be claimed FROM: the review-queue accept
// route arrives at 'pending_review', the pipeline auto-accept path at
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

// Shape the promote_import RPC returns (jsonb).
type RpcResult = {
  status: "promoted" | "already_accepted" | "conflict" | "not_found";
  contact_id?: string | null;
  booking_id?: string | null;
  commission_id?: string | null;
  row_status?: string | null;
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
    .select("id, tenant_id, import_path, source_ref, document_type, raw_extracted_fields, extraction_overall_confidence, submitted_by_user_id, status, promoted_contact_id, promoted_booking_id")
    .eq("id", queue_row_id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: `load_queue_row_failed: ${loadErr.message}` };
  if (!rowData) return { ok: false, error: "queue_row_not_found" };

  const row = rowData as QueueRow;
  const { document_type } = row;

  // commission_statement is handled by §14.8 statement-matching, not here.
  if (!document_type || !PROMOTABLE_DOCUMENT_TYPES.has(document_type)) {
    return { ok: false, needs_review: true, reason: "unsupported_document_type" };
  }

  return document_type === "booking_confirmation"
    ? promoteBooking(svc, row, row.raw_extracted_fields as BookingConfirmationFields, getAdapterRate, acceptingUserId)
    : promoteLeadOrIntake(
        svc,
        row,
        row.raw_extracted_fields as LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] },
        acceptingUserId,
      );
}

// ── lead / intake ────────────────────────────────────────────────────────

async function promoteLeadOrIntake(
  svc: Svc,
  row: QueueRow,
  fields: LeadNotificationFields & { preferences?: IntakeFormFields["preferences"] },
  acceptingUserId: string | null | undefined,
): Promise<PromoteResult> {
  const name = splitName(fields.contact_name ?? null);
  const result = await invokePromoteRpc(svc, row, acceptingUserId, {
    is_booking: false,
    contact_first_name: name.first,
    contact_last_name: name.last,
    contact_email: fields.contact_email ?? null,
    contact_phone: fields.contact_phone ?? null,
    contact_notes: buildLeadNotes(fields),
  });

  // Only on a fresh promote — an already_accepted result means a prior run
  // (or a whole-step Inngest retry) already wrote this audit row; writing again
  // would duplicate it.
  if (result.ok && result.status === "promoted") {
    await writeAuditLog({
      tenant_id: row.tenant_id,
      actor_user_id: acceptingUserId ?? null,
      actor_type: acceptingUserId ? "user" : "system",
      action: "import.accepted",
      resource_type: "import_queue",
      resource_id: row.id,
      context: {
        document_type: row.document_type,
        promoted_contact_id: result.contact_id,
        confidence: row.extraction_overall_confidence,
      },
    });
  }
  return result;
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
  // §34.7.4 / §34.9 — sub-host tenants cannot import bookings (the platform is
  // host-of-record for sub-hosts). Block before any writes.
  const { data: tenantData } = await svc
    .from("tenants")
    .select("tenant_type")
    .eq("id", row.tenant_id)
    .maybeSingle();
  const tenantType = (tenantData as { tenant_type?: string } | null)?.tenant_type;
  if (tenantType && tenantType !== "byo_host") {
    return { ok: false, error: `booking_import_not_permitted_for_tenant_type:${tenantType}` };
  }

  // §34.7.3 rate resolution. If null → can't promote; row stays in review.
  const rate = await resolveCommissionRate({ tenant_id: row.tenant_id, fields, getAdapterRate });
  if (!rate) {
    await safeAwait(
      svc
        .from("import_queue")
        .update({ status: "pending_review", parse_failure_reason: "commission_rate_missing" })
        .eq("id", row.id),
      "import_queue.reset_commission_rate_missing",
    );
    return { ok: false, needs_review: true, reason: "commission_rate_missing" };
  }

  const [lineRes, shipRes] = await Promise.all([
    resolveCanonical(fields.cruise_line, "line", svc),
    resolveCanonical(fields.ship_name, "ship", svc),
  ]);

  // #1576 — the booking-path contact has null email/phone, so it carries no
  // dedup key; the atomic RPC is what keeps it exactly-once (no crash window).
  const name = splitName(fields.passenger_last_names[0] ?? "(imported booking)");
  const result = await invokePromoteRpc(svc, row, acceptingUserId, {
    is_booking: true,
    contact_first_name: name.first,
    contact_last_name: name.last,
    contact_email: null,
    contact_phone: null,
    contact_notes: `Imported booking: ${fields.cruise_line ?? "?"} / ${fields.ship_name ?? "?"} on ${fields.sailing_date ?? "?"}`,
    // Money invariant (#1658): *_cents already in the currency's ISO-4217 minor
    // unit — the RPC does not re-scale.
    cruise_line: fields.cruise_line,
    ship_name: fields.ship_name,
    sailing_date: fields.sailing_date,
    duration_nights: fields.duration_nights,
    departure_port: fields.departure_port,
    cabin_category: fields.cabin_category,
    total_amount_cents: fields.total_amount_cents,
    currency: fields.currency ?? "USD",
    provider_booking_ref: fields.provider_booking_ref,
    cruise_line_id: lineRes.matched ? lineRes.id : null,
    cruise_ship_id: shipRes.matched ? shipRes.id : null,
    commission_rate: rate.rate,
    commission_rate_source: rate.source,
  });

  // See promoteLeadOrIntake — gate on a fresh promote so an already_accepted
  // (idempotent replay / whole-step retry) doesn't duplicate the audit row.
  if (result.ok && result.status === "promoted") {
    await writeAuditLog({
      tenant_id: row.tenant_id,
      actor_user_id: acceptingUserId ?? null,
      actor_type: acceptingUserId ? "user" : "system",
      action: "import.accepted",
      resource_type: "import_queue",
      resource_id: row.id,
      context: {
        document_type: "booking_confirmation",
        promoted_contact_id: result.contact_id,
        promoted_booking_id: result.booking_id,
        commission_rate: rate.rate,
        commission_rate_source: rate.source,
        confidence: row.extraction_overall_confidence,
      },
    });
  }
  return result;
}

// ── RPC invocation + result mapping ──────────────────────────────────────

type BookingRpcArgs = {
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  departure_port: string | null;
  cabin_category: string | null;
  total_amount_cents: number | null;
  currency: string;
  provider_booking_ref: string | null;
  cruise_line_id: string | null;
  cruise_ship_id: string | null;
  commission_rate: number;
  commission_rate_source: string;
};

type ContactRpcArgs = {
  is_booking: boolean;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_notes: string | null;
};

async function invokePromoteRpc(
  svc: Svc,
  row: QueueRow,
  acceptingUserId: string | null | undefined,
  args: ContactRpcArgs & Partial<BookingRpcArgs>,
): Promise<PromoteResult> {
  const { data, error } = await svc.rpc("promote_import", {
    p_queue_row_id: row.id,
    p_tenant_id: row.tenant_id,
    p_claimable_statuses: PROMOTE_CLAIMABLE_STATUSES as unknown as string[],
    p_document_type: row.document_type,
    p_import_path: row.import_path,
    p_source_ref: row.source_ref,
    p_confidence: row.extraction_overall_confidence,
    p_raw_extracted_fields: (row.raw_extracted_fields ?? null) as Record<string, unknown> | null,
    p_accepting_user_id: acceptingUserId ?? null,
    p_submitted_by_user_id: row.submitted_by_user_id,
    p_contact_first_name: args.contact_first_name,
    p_contact_last_name: args.contact_last_name,
    p_contact_email: args.contact_email,
    p_contact_phone: args.contact_phone,
    p_contact_source_ref: `${row.import_path}:${row.source_ref}`,
    p_contact_notes: args.contact_notes,
    p_is_booking: args.is_booking,
    p_cruise_line: args.cruise_line ?? null,
    p_ship_name: args.ship_name ?? null,
    p_sailing_date: args.sailing_date ?? null,
    p_duration_nights: args.duration_nights ?? null,
    p_departure_port: args.departure_port ?? null,
    p_cabin_category: args.cabin_category ?? null,
    p_total_amount_cents: args.total_amount_cents ?? null,
    p_currency: args.currency ?? null,
    p_provider_booking_ref: args.provider_booking_ref ?? null,
    p_cruise_line_id: args.cruise_line_id ?? null,
    p_cruise_ship_id: args.cruise_ship_id ?? null,
    p_commission_rate: args.commission_rate ?? null,
    p_commission_rate_source: args.commission_rate_source ?? null,
  });
  if (error) return { ok: false, error: `promote_import_rpc_failed: ${error.message}` };

  const res = data as RpcResult | null;
  if (!res) return { ok: false, error: "promote_import_rpc_empty" };

  switch (res.status) {
    case "promoted":
      return res.contact_id
        ? {
            ok: true,
            status: "promoted",
            contact_id: res.contact_id,
            ...(res.booking_id ? { booking_id: res.booking_id } : {}),
            ...(res.commission_id ? { commission_id: res.commission_id } : {}),
          }
        : { ok: false, error: "promoted_without_contact_id" };
    case "already_accepted":
      // Idempotent: a prior promotion already finished. Return its records.
      return res.contact_id
        ? { ok: true, status: "already_accepted", contact_id: res.contact_id, ...(res.booking_id ? { booking_id: res.booking_id } : {}) }
        : { ok: false, error: "already_accepted_without_promoted_contact" };
    case "conflict":
      return { ok: false, error: `not_promotable_status:${res.row_status ?? "unknown"}` };
    case "not_found":
      return { ok: false, error: "queue_row_not_found" };
    default:
      // Contract drift: the RPC returned a status this mapping doesn't know.
      // Fail loud rather than silently resolving undefined.
      return { ok: false, error: `promote_import_rpc_bad_status:${String(res.status)}` };
  }
}

// contacts.first_name/last_name split: first token → first_name, remainder →
// last_name (both null-collapsed when empty). Matches the pre-RPC upsertContact.
function splitName(name: string | null): { first: string | null; last: string | null } {
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  return { first: first || null, last: rest.length > 0 ? rest.join(" ") : null };
}
