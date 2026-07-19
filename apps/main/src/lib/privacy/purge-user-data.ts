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
    category_1_conversations_user_id_nulled: number;
    category_2_narratives_nulled: number;
    category_2_memories_deleted: number;
    category_3_notes_anonymized: number;
    bookings_anonymized: number;
    commissions_anonymized: number;
    passenger_contacts_anonymized: number;
    // #2034 — booking_line_items.item_details nulled (free-form JSON, no user_id).
    line_items_scrubbed: number;
    // #2031 — inbound customer email content scrubbed on the two inbound tables.
    inbound_gmail_scrubbed: number;
    inbound_emails_scrubbed: number;
    // #2032 — ai_batch_requests.caller_metadata rows whose user_id was cleared.
    ai_batch_metadata_scrubbed: number;
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
  category_1_conversations_user_id_nulled: 0,
  category_2_narratives_nulled: 0,
  category_2_memories_deleted: 0,
  category_3_notes_anonymized: 0,
  bookings_anonymized: 0,
  commissions_anonymized: 0,
  passenger_contacts_anonymized: 0,
  line_items_scrubbed: 0,
  inbound_gmail_scrubbed: 0,
  inbound_emails_scrubbed: 0,
  ai_batch_metadata_scrubbed: 0,
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
    // d091-allow:service-role-tenant — §25.4 CCPA purge; sweeps this user's rows across all tenants by spec; cross-tenant required, service-role mandatory (purged user has no session).
    .from("bookings")
    .select("id")
    .eq("user_id", user_id);
  const bookingIds = ((bookingIdsForUser ?? []) as Array<{ id: string }>).map((b) => b.id);

  // #2031 — collect the user's email addresses BEFORE Step 5/8 clear them
  // (users.email is nulled in Step 8; contacts.user_id is detached in Step 5,
  // after which the user's contact emails can't be found). Used to reach the
  // inbound-email content that keys on the raw address, not a user_id.
  const emailAddresses = await loadUserEmailAddresses(db, user_id);

  let openDisputeCommissions: Array<{ id: string; dispute_status: string }> = [];
  if (bookingIds.length > 0) {
    const { data: disputes } = await db
      // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
      .from("commissions")
      .select("id, dispute_status, booking_id")
      .in("booking_id", bookingIds)
      .in("dispute_status", ["open", "under_review"]);
    openDisputeCommissions = (disputes ?? []) as Array<{ id: string; dispute_status: string }>;
  }

  if (openDisputeCommissions.length > 0) {
    try {
      const { data: snapshotBookings } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("bookings")
        .select("*")
        .in("id", bookingIds);
      const { data: snapshotCommissions } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("commissions")
        .select("*")
        .in("booking_id", bookingIds);
      const { data: snapshotMessages } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("messages")
        .update({
          content: null,
          supervisor_findings: { pii_fields_nulled: true },
        })
        .in("conversation_id", conversationIds)
        .select("id");
      if (error) throw new Error(`category_1_failed: ${error.message}`);
      counts.category_1_messages_nulled = Array.isArray(nulled) ? nulled.length : 0;

      // Greptile audit-followups P2 #13 — also null conversations.user_id.
      // Per §25.4a, message bodies are deleted but conversation metadata is
      // retained for tenant analytics ("N messages of which K were
      // customer-sent"). The FK to public.users, however, ties the conversation
      // row to the soon-to-be-purged user — analytics doesn't need the user_id
      // (already aggregated by conversation_id), and leaving the FK in place
      // means the user row can't be hard-deleted (FK constraint) and the
      // anonymization is incomplete (an audit query can still join
      // conversations -> users to find the deleted user).
      const { data: convNulled, error: convErr } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("conversations")
        .update({ user_id: null })
        .in("id", conversationIds)
        .not("user_id", "is", null)
        .select("id");
      if (convErr) throw new Error(`category_1_conversations_failed: ${convErr.message}`);
      counts.category_1_conversations_user_id_nulled = Array.isArray(convNulled) ? convNulled.length : 0;
    }

    // Step 4 — Category 2: AI-generated narratives.
    //   quotes.narrative — column added by the BP25 migration; rows tied via
    //   quotes.user_id.
    {
      const { data: qn, error } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("customer_memories")
        .delete()
        .eq("user_id", user_id)
        .select("id");
      if (error) throw new Error(`category_2_memories_failed: ${error.message}`);
      counts.category_2_memories_deleted = Array.isArray(mem) ? mem.length : 0;
    }

    // Step 4.5 — inbound customer email content (#2031). MUST run BEFORE Step 5
    //   detaches contacts: emailAddresses is derived from contacts.user_id (via
    //   loadUserEmailAddresses above), so a retry that re-enters after Step 5
    //   already nulled contacts.user_id would collect FEWER addresses and miss
    //   inbound rows keyed on a contact's address. Scrubbing here, while the
    //   contacts are still attached, means the rows are erased before any retry
    //   can lose the addresses (and the scrub is idempotent, so a later retry
    //   with a reduced address set finds nothing left to do).
    //
    //   gmail_inbound_messages and inbound_emails hold full inbound email
    //   (raw_payload + from/subject/body) keyed on the sender's raw address, not
    //   a user_id, so booking/contact anonymization never reaches them. The
    //   customer is the SENDER on inbound-to-persona mail, so we match their
    //   addresses against from_email CASE-INSENSITIVELY (external sender casing
    //   is arbitrary — an exact .in() would miss a mixed-case variant) and strip
    //   the PII columns, keeping the dedup/replay anchor row (message_id /
    //   provider_message_id) so a late webhook replay is still recognised.
    //   Idempotent: once from_email is redacted the row no longer matches.
    if (emailAddresses.length > 0) {
      const fromEmailFilter = ilikeAnyFilter("from_email", emailAddresses);

      // gmail_inbound_messages — all PII columns are nullable.
      const { data: gScrubbed, error: gErr } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA erasure of inbound content; cross-tenant by spec, service-role required (no user session).
        .from("gmail_inbound_messages")
        .update({ from_email: null, subject: null, body_text: null, body_html: null, raw_payload: null })
        .or(fromEmailFilter)
        .select("message_id");
      if (gErr) throw new Error(`inbound_gmail_scrub_failed: ${gErr.message}`);
      counts.inbound_gmail_scrubbed = Array.isArray(gScrubbed) ? gScrubbed.length : 0;

      // inbound_emails — from_email/raw_payload are NOT NULL, so redact rather
      // than null (empty-object payload, sentinel address); to_email is the
      // tenant persona (not the customer's PII) and stays.
      const { data: ieScrubbed, error: ieErr } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA erasure of inbound content; cross-tenant by spec, service-role required (no user session).
        .from("inbound_emails")
        .update({ from_email: "[erased]", subject: null, text_body: null, raw_payload: {} })
        .or(fromEmailFilter)
        .select("id");
      if (ieErr) throw new Error(`inbound_emails_scrub_failed: ${ieErr.message}`);
      counts.inbound_emails_scrubbed = Array.isArray(ieScrubbed) ? ieScrubbed.length : 0;
    }

    // Step 5 — Category 3: tenant CRM notes anonymization.
    //   Surface added by this migration: contacts.notes + contacts.anonymized_customer_hash.
    //   Per §25.4a, text is RETAINED; only the user FK is removed.
    let affected_tenant_ids: string[] = [];
    {
      const { data: cnotes, error } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("commissions")
        .update({
          anonymized_customer_hash: customer_hash,
          anonymized_at: new Date().toISOString(),
        })
        .in("booking_id", bookingIds)
        .select("id");
      if (cerr) throw new Error(`commission_anonymize_failed: ${cerr.message}`);
      counts.commissions_anonymized = Array.isArray(can) ? can.length : 0;

      // Step 6.5 — booking_line_items.item_details (#2034). This table has no
      // user_id and is reached only through the booking. item_details is
      // free-form JSON (per-type; transfer/excursion/insurance/other were
      // unvalidated) that can carry passenger names/DOB/policy numbers, so
      // null it for every line item on a purged booking. Booking-level
      // anonymization (Step 6) alone breaks the FK join but leaves the blob.
      const { data: liScrubbed, error: liErr } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("booking_line_items")
        .update({ item_details: null })
        .in("booking_id", bookingIds)
        .not("item_details", "is", null)
        .select("id");
      if (liErr) throw new Error(`line_items_scrub_failed: ${liErr.message}`);
      counts.line_items_scrubbed = Array.isArray(liScrubbed) ? liScrubbed.length : 0;
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
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("contacts")
        .select("id")
        .eq("anonymized_customer_hash", customer_hash);
      const anonContactIds = ((anonContacts ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (anonContactIds.length > 0) {
        const { data: paxRows } = await db
          // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
          .from("booking_passengers")
          .select("id")
          .in("contact_id", anonContactIds);
        counts.passenger_contacts_anonymized = Array.isArray(paxRows) ? paxRows.length : 0;
      }
    }

    // Step 7.7 — ai_batch_requests.caller_metadata (#2032). MUST run BEFORE the
    //   Step 8 status='purged' flip: that flip is the purge's idempotency guard
    //   (the caller skips re-running the purge once status='purged'), so a scrub
    //   that failed AFTER the flip would never be retried (mirrors the #1958
    //   ordering fix in the same file). A service-role-only table whose
    //   caller_metadata threads the user_id for some purposes (extract-memory
    //   etc.), so a purged user's UUID otherwise persists indefinitely. Null the
    //   whole payload for this user's rows — transient producer→consumer context,
    //   not durable record.
    {
      const { data: bmScrubbed, error } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("ai_batch_requests")
        .update({ caller_metadata: null })
        .eq("caller_metadata->>user_id", user_id)
        .select("id");
      if (error) throw new Error(`ai_batch_metadata_scrub_failed: ${error.message}`);
      counts.ai_batch_metadata_scrubbed = Array.isArray(bmScrubbed) ? bmScrubbed.length : 0;
    }

    // Step 8 — users row PII clear + status='purged'. Runs LAST of the PII steps
    //   because status='purged' is the idempotency guard — every PII scrub above
    //   must complete before we mark the purge done.
    {
      const { error } = await db
        // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
        .from("users")
        .update({
          email: null,
          phone: null,
          first_name: null,
          last_name: null,
          display_name: null,
          // #2032 — notif_preferences is exported by the data-export builder
          // and is PII-shaped; null it here so the purge is defensively
          // correct before a writer for it lands.
          notif_preferences: null,
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
      category_1_conversations_user_id_nulled_count: counts.category_1_conversations_user_id_nulled,
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

// #2031/#2038 — build a PostgREST `.or()` filter matching `column`
// case-insensitively against ANY of the values.
//
// A value must satisfy TWO distinct grammars before it reaches Postgres:
//   1. LIKE metacharacters (\ % _) → backslash-escaped so each term is an exact
//      case-folded match, not a pattern (an address with a literal `_` must not
//      match neighbouring chars).
//   2. PostgREST's or()-grammar reserved chars. RFC 5322 permits quoted
//      local-parts like `"a,b(c)"@example.com` carrying `,` `(` `)` — the very
//      delimiters that split or() terms and group logic. Left raw, such an
//      address produces a malformed filter → PostgREST 400 → the scrub throws
//      (fail-loud, not a silent PII miss, but still a purge failure). Wrapping
//      the value in double quotes makes PostgREST read those bytes literally;
//      inside the quotes a literal `"`/`\` is backslash-escaped (`\"` / `\\`).
//
// #2038/CodeQL alert 105 (js/double-escaping): this used to be two sequential
// `.replace()` passes — LIKE-escape, then DSL-escape the LIKE-escaped output.
// A `\` needs BOTH escapes, so it's the char worth hand-verifying. Truth table
// for a single literal `\` in the original value, tracing it through each
// stage (escape at rest, wire value inside the `."…"` quotes, what PostgREST's
// `\"`/`\\` unquote hands to the LIKE engine, what the LIKE engine — itself
// `\`-escaped — resolves back to):
//
//   original  →  LIKE-escaped  →  DSL-escaped (wire)  →  PostgREST unquotes to  →  LIKE resolves to
//     \       →      \\        →        \\\\           →          \\            →         \
//
// It round-trips correctly — verified against PostgREST's documented `\"`/`\\`
// quoted-string unescape and Postgres's `\`-escaped LIKE grammar, and checked
// by script against backslash/percent/underscore/quote combinations (single,
// doubled, and mixed with `"`). The two-pass version was NOT actually broken
// for backslashes. It's still the shape CodeQL's double-escaping heuristic
// flags on sight, though — two regexes run in sequence, the second free to
// re-match bytes the first one just inserted, is inherently hard to verify by
// inspection even when (as here) it happens to compose correctly.
//
// Restructured into a single pass below: one regex scan of the ORIGINAL value
// where each matched character maps directly to its fully-escaped output (both
// grammars pre-composed, in the fixed order above — LIKE-escape then
// DSL-escape). No regex ever re-scans another regex's output, so there's
// nothing left for the double-escaping heuristic to match, and the escaping
// for each character class is expressed exactly once.
//
// Values are our own user/contact emails, so this is robustness against odd-but-
// valid addresses, not an injection defense.
function ilikeAnyFilter(column: string, values: string[]): string {
  return values.map((v) => `${column}.ilike."${escapeForIlikeDsl(v)}"`).join(",");
}

function escapeForIlikeDsl(v: string): string {
  return v.replace(/[\\%_"]/g, (c) => {
    // \ needs both escapes: LIKE-escape (\ -> \\), then DSL-escape each of
    // those two resulting backslashes (\ -> \\, applied twice) = \\\\.
    if (c === "\\") return "\\\\\\\\";
    // " has no LIKE meaning — DSL-escape only (" -> \").
    if (c === '"') return `\\${c}`;
    // % and _ are LIKE metachars — LIKE-escape (-> \c), then DSL-escape the
    // one inserted backslash (\ -> \\) = \\c.
    return `\\\\${c}`;
  });
}

// #2031 — every email address that identifies the user for inbound-content
// matching: the account email plus any contact emails they own, deduped
// case-insensitively. Matching against from_email happens case-insensitively via
// ilike at the call site (ilikeAnyFilter), so the stored casing is irrelevant to
// correctness — we keep the first-seen form purely for readable audit/logging.
async function loadUserEmailAddresses(
  db: SupabaseClient,
  user_id: string,
): Promise<string[]> {
  const byLower = new Map<string, string>();
  const add = (email: string | null | undefined) => {
    if (!email) return;
    const key = email.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, email);
  };

  const { data: userRow } = await db
    // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
    .from("users")
    .select("email")
    .eq("id", user_id)
    .maybeSingle();
  add((userRow as { email?: string | null } | null)?.email);

  const { data: contactRows } = await db
    // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
    .from("contacts")
    .select("email")
    .eq("user_id", user_id)
    .not("email", "is", null);
  for (const c of (contactRows ?? []) as Array<{ email: string | null }>) add(c.email);

  return Array.from(byLower.values());
}

async function loadConversationIds(
  db: SupabaseClient,
  user_id: string,
): Promise<string[]> {
  const { data } = await db
    // d091-allow:service-role-tenant — §25.4 CCPA purge; cross-tenant by spec, service-role required (no user session).
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
    category_1_conversations_user_id_nulled_count: counts.category_1_conversations_user_id_nulled,
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
