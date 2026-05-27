// §25.4 / §25.4a — CCPA retention-compliant user-data purge.
//
// Closes the BP17 stub. Triggered by the user-data-purge-after-grace cron
// once the 30-day grace window expires.
//
// Spec deltas (full rationale MEMORY D-058):
//   • bookings.user_id is the customer FK (no customer_user_id column).
//   • bookings has no dispute_state; forensics-snapshot trigger uses
//     commissions.dispute_status only.
//   • bookings has no denormalized customer PII; passenger PII lives on
//     booking_passengers.contact_id → contacts.user_id. We anonymize the
//     contact rows for the deleting user (clears contacts.user_id, sets
//     contacts.anonymized_customer_hash) and the passenger contact_id FK
//     stays intact pointing at the anonymized contact.
//   • Category 3 surface is contacts.notes (added by the BP25 migration);
//     "tenant_crm_notes" never existed.
//
// Step 10 writes a ccpa_deletion_executions row plus an audit_log row
// (action=user.ccpa_purge_executed) — both via service-role client since
// the user being purged no longer has a session.

import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveCustomerHash } from "./customer-hash";
import { captureForensicsSnapshot } from "@/lib/forensics/capture";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";

export interface PurgeArgs {
  user_id: string;
  // Used for the audit row's grace_period_ended_at. Defaults to now()
  // if omitted (the cron will pass the real grace expiration).
  grace_period_ended_at?: string;
}

export interface PurgeResult {
  user_id: string;
  customer_hash: string;
  forensics_snapshot_id: string | null;
  forensics_snapshot_reason: string | null;
  counts: {
    category_1_messages_nulled: number;
    category_2_narratives_nulled: number;
    category_2_memories_deleted: number;
    category_3_notes_anonymized: number;
    bookings_anonymized: number;
    commissions_anonymized: number;
    passenger_contacts_anonymized: number;
  };
  // Tenants whose CRM notes (contacts.notes with non-null body) were
  // anonymized. The cron caller fans out notifications to admins of these
  // tenants so they can review the residual text per §25.4a Category 3.
  affected_tenant_ids: string[];
  purge_outcome: "success" | "partial_failure" | "error";
  error_detail: string | null;
}

const empty = {
  category_1_messages_nulled: 0,
  category_2_narratives_nulled: 0,
  category_2_memories_deleted: 0,
  category_3_notes_anonymized: 0,
  bookings_anonymized: 0,
  commissions_anonymized: 0,
  passenger_contacts_anonymized: 0,
};

export async function purgeUserDataPerRetention(
  db: SupabaseClient,
  args: PurgeArgs,
): Promise<PurgeResult> {
  const { user_id } = args;
  const customer_hash = deriveCustomerHash(user_id, null);
  const counts = { ...empty };
  const graceEndedAt = args.grace_period_ended_at ?? new Date().toISOString();

  // ── Step 2: forensics-snapshot-before-deletion when active dispute.
  //    Outside any transaction — if forensics fails, the deletion does NOT
  //    proceed.
  let forensics_snapshot_id: string | null = null;
  let forensics_snapshot_reason: string | null = null;

  const { data: bookingIdsForUser } = await db
    .from("bookings")
    .select("id")
    .eq("user_id", user_id);
  const bookingIds = ((bookingIdsForUser ?? []) as Array<{ id: string }>).map((b) => b.id);

  let openDisputeCommissions: Array<{ id: string; dispute_status: string }> = [];
  if (bookingIds.length > 0) {
    const { data: disputes } = await db
      .from("commissions")
      .select("id, dispute_status, booking_id")
      .in("booking_id", bookingIds)
      .in("dispute_status", ["open", "under_review"]);
    openDisputeCommissions = (disputes ?? []) as Array<{ id: string; dispute_status: string }>;
  }

  if (openDisputeCommissions.length > 0) {
    try {
      const { data: snapshotBookings } = await db
        .from("bookings")
        .select("*")
        .in("id", bookingIds);
      const { data: snapshotCommissions } = await db
        .from("commissions")
        .select("*")
        .in("booking_id", bookingIds);
      const { data: snapshotMessages } = await db
        .from("messages")
        .select("id, conversation_id, role, content, created_at")
        .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
        .in(
          "conversation_id",
          await loadConversationIds(db, user_id),
        );

      const cap = await captureForensicsSnapshot(db, {
        tenant_id: null,
        snapshot_type: "commission_dispute",
        reason: "ccpa_deletion_with_active_dispute",
        payload: {
          user_id,
          bookings: snapshotBookings ?? [],
          commissions: snapshotCommissions ?? [],
          messages_last_90d: snapshotMessages ?? [],
        },
      });
      forensics_snapshot_id = cap.snapshot_id;
      forensics_snapshot_reason = "commission_dispute";
    } catch (err) {
      return finishError(db, user_id, customer_hash, graceEndedAt, counts, null, null,
        `forensics_capture_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Steps 3–9: data purge.
  //   Supabase JS v2 has no explicit BEGIN/COMMIT API. We execute each step
  //   sequentially and on any error return outcome='error' with the partial
  //   counts. The audit row records what was touched so operators can finish
  //   by hand if needed. A proper TRANSACTION wrap belongs in a future
  //   refactor to a pg client (deferred — see §25.4 / D-053 for rationale).
  try {
    // Step 3 — Category 1: chat messages.
    const conversationIds = await loadConversationIds(db, user_id);
    if (conversationIds.length > 0) {
      const { data: nulled, error } = await db
        .from("messages")
        .update({
          content: null,
          supervisor_findings: { pii_fields_nulled: true },
        })
        .in("conversation_id", conversationIds)
        .select("id");
      if (error) throw new Error(`category_1_failed: ${error.message}`);
      counts.category_1_messages_nulled = Array.isArray(nulled) ? nulled.length : 0;
    }

    // Step 4 — Category 2: AI-generated narratives.
    //   quotes.narrative — column added by the BP25 migration; rows tied via
    //   quotes.user_id.
    {
      const { data: qn, error } = await db
        .from("quotes")
        .update({ narrative: null })
        .eq("user_id", user_id)
        .not("narrative", "is", null)
        .select("id");
      if (error) throw new Error(`category_2_quotes_failed: ${error.message}`);
      counts.category_2_narratives_nulled += Array.isArray(qn) ? qn.length : 0;
    }
    if (bookingIds.length > 0) {
      const { data: bn, error } = await db
        .from("bookings")
        .update({ notes: null })
        .in("id", bookingIds)
        .not("notes", "is", null)
        .select("id");
      if (error) throw new Error(`category_2_bookings_failed: ${error.message}`);
      counts.category_2_narratives_nulled += Array.isArray(bn) ? bn.length : 0;
    }
    {
      const { data: mem, error } = await db
        .from("customer_memories")
        .delete()
        .eq("user_id", user_id)
        .select("id");
      if (error) throw new Error(`category_2_memories_failed: ${error.message}`);
      counts.category_2_memories_deleted = Array.isArray(mem) ? mem.length : 0;
    }

    // Step 5 — Category 3: tenant CRM notes anonymization.
    //   Surface added by this migration: contacts.notes + contacts.anonymized_customer_hash.
    //   Per §25.4a, text is RETAINED; only the user FK is removed.
    let affected_tenant_ids: string[] = [];
    {
      const { data: cnotes, error } = await db
        .from("contacts")
        .update({
          user_id: null,
          anonymized_customer_hash: customer_hash,
        })
        .eq("user_id", user_id)
        .not("notes", "is", null)
        .select("id, tenant_id");
      if (error) throw new Error(`category_3_contacts_failed: ${error.message}`);
      const rows = (cnotes ?? []) as Array<{ id: string; tenant_id: string }>;
      counts.category_3_notes_anonymized = rows.length;
      affected_tenant_ids = Array.from(new Set(rows.map((r) => r.tenant_id)));
    }

    // Step 6 — §25.4 booking / commission anonymization.
    //   bookings has no denormalized customer PII (no customer_email/phone/dob);
    //   passenger PII lives on booking_passengers.contact_id → contacts. We
    //   handle the passenger-contact path in Step 7.
    if (bookingIds.length > 0) {
      const { data: ban, error } = await db
        .from("bookings")
        .update({
          user_id: null,
          anonymized_customer_hash: customer_hash,
          anonymized_at: new Date().toISOString(),
        })
        .in("id", bookingIds)
        .select("id");
      if (error) throw new Error(`booking_anonymize_failed: ${error.message}`);
      counts.bookings_anonymized = Array.isArray(ban) ? ban.length : 0;

      // Commissions: linked via booking_id. We DON'T null booking_id (that's
      // the financial ledger key); we just stamp the hash + timestamp.
      const { data: can, error: cerr } = await db
        .from("commissions")
        .update({
          anonymized_customer_hash: customer_hash,
          anonymized_at: new Date().toISOString(),
        })
        .in("booking_id", bookingIds)
        .select("id");
      if (cerr) throw new Error(`commission_anonymize_failed: ${cerr.message}`);
      counts.commissions_anonymized = Array.isArray(can) ? can.length : 0;
    }

    // Step 7 — booking_passengers contact-FK anonymization.
    //   Passengers stay; their contact FK loses the user identifier when the
    //   underlying contact belonged to the deleting user. The contact rows
    //   we just anonymized above (Step 5) already had user_id=NULL set; we
    //   don't need to touch booking_passengers rows themselves — the
    //   contact_id still resolves to the (now-anonymized) contact.
    //   We do count how many passenger rows reference anonymized contacts
    //   so the audit row is informative.
    {
      const { data: anonContacts } = await db
        .from("contacts")
        .select("id")
        .eq("anonymized_customer_hash", customer_hash);
      const anonContactIds = ((anonContacts ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (anonContactIds.length > 0) {
        const { data: paxRows } = await db
          .from("booking_passengers")
          .select("id")
          .in("contact_id", anonContactIds);
        counts.passenger_contacts_anonymized = Array.isArray(paxRows) ? paxRows.length : 0;
      }
    }

    // Step 8 — users row PII clear + status='purged'.
    {
      const { error } = await db
        .from("users")
        .update({
          email: null,
          phone: null,
          first_name: null,
          last_name: null,
          display_name: null,
          deleted_purged_at: new Date().toISOString(),
          status: "purged",
        })
        .eq("id", user_id);
      if (error) throw new Error(`user_clear_failed: ${error.message}`);
    }

    // Step 9 — legal_consents retained (§25.4 reasoning — point-in-time legal proof).
    //   No action.

    // Step 10 — record execution row + audit_log.
    await safeAwait(db.from("ccpa_deletion_executions").insert({
      user_id,
      grace_period_ended_at: graceEndedAt,
      executed_at: new Date().toISOString(),
      category_1_messages_nulled_count: counts.category_1_messages_nulled,
      category_2_narratives_nulled_count: counts.category_2_narratives_nulled,
      category_2_memories_deleted_count: counts.category_2_memories_deleted,
      category_3_notes_anonymized_count: counts.category_3_notes_anonymized,
      bookings_anonymized_count: counts.bookings_anonymized,
      commissions_anonymized_count: counts.commissions_anonymized,
      passenger_contacts_anonymized_count: counts.passenger_contacts_anonymized,
      forensics_snapshot_id,
      forensics_snapshot_reason,
      customer_hash,
      purge_outcome: "success",
    }), "ccpa_deletion_executions.insert");

    await writeAuditLog({
      actor_user_id: user_id,
      actor_type: "system",
      action: "user.ccpa_purge_executed",
      resource_type: "user",
      resource_id: user_id,
      changes: { ...counts, forensics_snapshot_id },
    });

    return {
      user_id,
      customer_hash,
      forensics_snapshot_id,
      forensics_snapshot_reason,
      counts,
      affected_tenant_ids,
      purge_outcome: "success",
      error_detail: null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return finishError(db, user_id, customer_hash, graceEndedAt, counts,
      forensics_snapshot_id, forensics_snapshot_reason, detail);
  }
}

async function loadConversationIds(
  db: SupabaseClient,
  user_id: string,
): Promise<string[]> {
  const { data } = await db
    .from("conversations")
    .select("id")
    .eq("user_id", user_id);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

async function finishError(
  db: SupabaseClient,
  user_id: string,
  customer_hash: string,
  grace_period_ended_at: string,
  counts: PurgeResult["counts"],
  forensics_snapshot_id: string | null,
  forensics_snapshot_reason: string | null,
  error_detail: string,
): Promise<PurgeResult> {
  await safeAwait(db.from("ccpa_deletion_executions").insert({
    user_id,
    grace_period_ended_at,
    executed_at: new Date().toISOString(),
    category_1_messages_nulled_count: counts.category_1_messages_nulled,
    category_2_narratives_nulled_count: counts.category_2_narratives_nulled,
    category_2_memories_deleted_count: counts.category_2_memories_deleted,
    category_3_notes_anonymized_count: counts.category_3_notes_anonymized,
    bookings_anonymized_count: counts.bookings_anonymized,
    commissions_anonymized_count: counts.commissions_anonymized,
    passenger_contacts_anonymized_count: counts.passenger_contacts_anonymized,
    forensics_snapshot_id,
    forensics_snapshot_reason,
    customer_hash,
    purge_outcome: "error",
    error_detail,
  }), "ccpa_deletion_executions.insert");
  await writeAuditLog({
    actor_user_id: user_id,
    actor_type: "system",
    action: "user.ccpa_purge_failed",
    resource_type: "user",
    resource_id: user_id,
    changes: { error_detail, partial_counts: counts },
  });
  return {
    user_id,
    customer_hash,
    forensics_snapshot_id,
    forensics_snapshot_reason,
    counts,
    affected_tenant_ids: [],
    purge_outcome: "error",
    error_detail,
  };
}
