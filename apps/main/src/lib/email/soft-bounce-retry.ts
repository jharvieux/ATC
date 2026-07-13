// §23.7 / #1611 — Soft-bounce retry engine (real re-delivery).
//
// Operator decision (2026-07-12, option (a)): re-send the exact rendered HTML
// stored at send time (email_retry_content) on a soft bounce, at +6h / +12h /
// +24h. On the 4th consecutive failure (attempt 4, terminal) the address is
// suppressed as a hard bounce. Success (any attempt delivers) terminates the
// chain early.
//
// The chain is SELF-DRIVING: each attempt schedules the next itself. It does
// NOT rely on the Resend webhook to advance — the webhook only updates delivery
// status on the re-send rows (which the chain reads) and, crucially, does NOT
// start a fresh chain for re-send rows (gated on email_log.retry_of). Re-sends
// go back through sendEmail so they inherit suppression / rate-limit / staging
// isolation.
//
// Duplicate-send defense is TWO layers, because they cover DIFFERENT things:
//   - The deterministic per-attempt Resend Idempotency-Key dedupes only the
//     VENDOR DELIVERY (D-091 #23) — Resend won't physically re-transmit the
//     message. It does NOT cover sendEmail's own DB bookkeeping: an un-stepped
//     re-run would insert a fresh email_log row and bump incrementEmailSent. So
//     the key alone does not make a re-run harmless; sendEmail is wrapped in its
//     own memoized step.run boundary (Pattern-14) below to keep a real Inngest
//     function-retry from re-invoking it. The last_send_log_id write is a
//     SEPARATE, later step (#1832) — a transient DB error writing it must retry
//     only that write, not re-run the already-memoized send.
//   - completed_attempt (written AFTER scheduleNext succeeds) is the completion
//     marker that stops a re-run of an ALREADY-FINISHED attempt from reaching
//     sendEmail again — that's what prevents the orphaned email_log row + spurious
//     counter bump. claimed_attempt (D-091 #21) orders attempts and identifies the
//     genuine crash-mid-attempt case that MUST resume. Concurrent duplicates of the
//     same attempt (a Svix webhook redelivery, a compounded scheduleNext) are
//     collapsed upstream by a deterministic Inngest event id, so the completion
//     marker only ever arbitrates sequential Inngest function-retries.
//
// This module holds the pure logic (dependency-injected sleep / send / schedule)
// so it's testable without the Inngest step runtime; inngest/email-soft-bounce-retry.ts
// is the thin wrapper that supplies the real step primitives.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SendEmailInput, EmailSendResult } from "./send";
import type { EmailCategory } from "./rate-limit";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

// Per-attempt delay before attempts 1/2/3 re-send.
export const RETRY_DELAYS_HOURS = [6, 12, 24];
export const MAX_ATTEMPTS = RETRY_DELAYS_HOURS.length;
// After the last re-send (attempt 3), wait this long for its delivery webhook
// to settle before the terminal suppress judgment (attempt 4).
export const TERMINAL_GRACE_HOURS = 6;

export interface SoftBounceRetryPayload {
  email_log_id: string;
  tenant_id: string;
  attempt: number;
}

export interface SoftBounceRetryDeps {
  db: SupabaseClient;
  sendEmail: (input: SendEmailInput) => Promise<EmailSendResult>;
  // Durable sleep. In production this is Inngest's step.sleep; in tests a stub.
  sleep: (id: string, hours: number) => Promise<void>;
  // Schedule the next attempt (Inngest event). Absent scheduling in the
  // terminal branch is expected.
  scheduleNext: (payload: SoftBounceRetryPayload) => Promise<void>;
  // Durable step boundary (Inngest step.run in production, keyed by `id`).
  // Memoizes fn's return value across whole-function retries, so a retry that
  // re-enters AFTER a given step already completed does not re-invoke it.
  // sendEmail and the last_send_log_id write are two SEPARATE steps (#1832),
  // so a retry of the record write never re-invokes the memoized send. Test
  // stubs just call fn() directly — they don't model Inngest's memoization,
  // which is why the crash-resume test still observes two sends (see that
  // test's comment).
  runStep: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
}

export type SoftBounceRetryOutcome =
  | "skipped_past_grace" // §15.16 — tenant past billing grace; stop retrying
  | "no_content" // stored payload gone (expired / never stored); can't re-send
  | "already_terminated" // a prior attempt delivered, or the address is suppressed
  | "claim_lost" // duplicate/out-of-order event; another run owns this attempt
  | "tenant_missing" // tenant row vanished; can't re-send
  | "suppressed_terminal" // exhausted all attempts → hard-bounce + suppress
  | "resent" // this attempt re-sent and scheduled the next
  | "send_suppressed"; // sendEmail returned suppressed → address already blocked

interface RetryContentRow {
  email_log_id: string;
  tenant_id: string;
  to_email: string;
  subject: string;
  template_id: string;
  email_category: string;
  html: string;
  reply_to: string | null;
  related_booking_id: string | null;
  related_group_id: string | null;
  user_id: string | null;
  contact_id: string | null;
  claimed_attempt: number;
  last_send_log_id: string | null;
}

const RETRY_CONTENT_COLS =
  "email_log_id, tenant_id, to_email, subject, template_id, email_category, html, " +
  "reply_to, related_booking_id, related_group_id, user_id, contact_id, claimed_attempt, last_send_log_id";

async function purgeContent(db: SupabaseClient, emailLogId: string): Promise<void> {
  await safeAwait(
    // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
    db.from("email_retry_content").delete().eq("email_log_id", emailLogId),
    "email_retry_content.delete",
  );
}

async function isTerminalStatus(db: SupabaseClient, logId: string): Promise<boolean> {
  const { data } = await db.from("email_log").select("status").eq("id", logId).maybeSingle();
  const status = (data as { status?: string } | null)?.status;
  // Delivered = success; hard_bounced / complained = the webhook already
  // suppressed the address. All three mean: stop the chain.
  return status === "delivered" || status === "hard_bounced" || status === "complained";
}

async function markHardBounceAndSuppress(
  db: SupabaseClient,
  emailLogId: string,
  tenantId: string,
  toEmail: string,
): Promise<void> {
  // Order matters for crash-recovery. The terminal branch short-circuits on
  // isTerminalStatus(email_log_id), so once email_log.status is flipped to
  // hard_bounced a re-run returns "already_terminated" and never reaches this
  // function again. If the status flip ran FIRST and the process crashed before
  // the suppression upsert, the address would be hard-bounced but UN-suppressed
  // forever. So write the suppression FIRST, then flip the status: both writes
  // are idempotent, and a crash between them re-runs both safely because the
  // status is still soft_bounced (isTerminalStatus false) on the retry.
  await safeAwait(
    db.from("email_suppressions").upsert(
      { tenant_id: tenantId, email_address: toEmail, reason: "hard_bounce" },
      { onConflict: "tenant_id,email_address,reason" },
    ),
    "email_suppressions.upsert",
  );
  await safeAwait(
    db
      .from("email_log")
      .update({ status: "hard_bounced", bounce_reason: "soft_bounce_max_retries" })
      .eq("id", emailLogId),
    "email_log.update",
  );
}

async function loadTenantForSend(
  db: SupabaseClient,
  tenantId: string,
): Promise<SendEmailInput["tenant"] | null> {
  const [{ data: tenantRow }, { data: brandingRow }] = await Promise.all([
    db.from("tenants").select("id, legal_name, mailing_address").eq("id", tenantId).maybeSingle(),
    db
      .from("tenant_branding")
      .select(
        "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name, email_from_domain, email_from_domain_verified_at",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ]);
  if (!tenantRow) return null;
  const t = tenantRow as { id: string; legal_name: string | null; mailing_address: string | null };
  const b = (brandingRow ?? {}) as {
    email_send_pattern?: "platform_resend" | "tenant_resend";
    tenant_resend_api_key_encrypted?: string | null;
    email_from_address?: string | null;
    email_from_name?: string | null;
    email_from_domain?: string | null;
    email_from_domain_verified_at?: string | null;
  };
  return {
    id: t.id,
    legal_name: t.legal_name ?? "AI Travel Concierge",
    mailing_address: t.mailing_address ?? null,
    email_send_pattern: b.email_send_pattern ?? "platform_resend",
    tenant_resend_api_key_encrypted: b.tenant_resend_api_key_encrypted ?? null,
    email_from_address: b.email_from_address ?? null,
    email_from_name: b.email_from_name ?? null,
    email_from_domain: b.email_from_domain ?? null,
    email_from_domain_verified_at: b.email_from_domain_verified_at ?? null,
  };
}

/**
 * Runs one attempt of the §23.7 soft-bounce retry chain. Returns the outcome so
 * callers (and tests) can assert exactly which branch ran.
 */
export async function runSoftBounceRetryAttempt(
  deps: SoftBounceRetryDeps,
  payload: SoftBounceRetryPayload,
): Promise<SoftBounceRetryOutcome> {
  const { db, sendEmail, sleep, scheduleNext, runStep } = deps;
  const { email_log_id, tenant_id, attempt } = payload;

  // §15.16 — don't keep retrying for a tenant past its billing grace period.
  const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
  if (!paymentCheck.ok) return "skipped_past_grace";

  const { data: contentRow } = await db
    // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
    .from("email_retry_content")
    .select(RETRY_CONTENT_COLS)
    .eq("email_log_id", email_log_id)
    .maybeSingle();
  if (!contentRow) return "no_content";
  const content = contentRow as unknown as RetryContentRow;

  // Terminal attempt: the last re-send has had TERMINAL_GRACE_HOURS to deliver.
  // Suppress only if it still hasn't.
  if (attempt > MAX_ATTEMPTS) {
    await sleep("retry-terminal-grace", TERMINAL_GRACE_HOURS);
    const checkId = content.last_send_log_id ?? email_log_id;
    if (await isTerminalStatus(db, checkId)) {
      await purgeContent(db, email_log_id);
      return "already_terminated";
    }
    await markHardBounceAndSuppress(db, email_log_id, tenant_id, content.to_email);
    await purgeContent(db, email_log_id);
    return "suppressed_terminal";
  }

  await sleep(`retry-delay-${attempt}`, RETRY_DELAYS_HOURS[attempt - 1] ?? RETRY_DELAYS_HOURS[0]!);

  // A prior attempt may have delivered (or the address got suppressed) during
  // the sleep — check before sending again.
  const checkId = content.last_send_log_id ?? email_log_id;
  if (await isTerminalStatus(db, checkId)) {
    await purgeContent(db, email_log_id);
    return "already_terminated";
  }

  // CAS-claim this attempt (D-091 #21). A duplicate retry event finds
  // claimed_attempt already advanced and the row-count is 0 → skip, so no
  // attempt double-sends even if the event is delivered twice.
  const { data: claimedRows } = await db
    // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
    .from("email_retry_content")
    .update({ claimed_attempt: attempt })
    .eq("email_log_id", email_log_id)
    .eq("claimed_attempt", attempt - 1)
    .select("email_log_id");
  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    // Zero-row claim is ambiguous. Two DB signals disambiguate it — completed_attempt
    // (written only AFTER scheduleNext lands) and claimed_attempt:
    //   - completed_attempt >= this attempt → the attempt (or a later one) already
    //     ran to completion. Re-running would insert an orphaned email_log row and
    //     bump the sent counter, neither of which the Resend Idempotency-Key dedupes,
    //     so we must NOT re-send → claim_lost.
    //   - claimed_attempt == this attempt but completed_attempt < it → a prior run
    //     claimed this attempt but never finished the send + scheduleNext. The
    //     trigger isn't only a process crash — ANY un-stepped exception between the
    //     claim and completed_attempt lands here on the Inngest re-run. Resume, or
    //     the escalation chain dies silently.
    //   - otherwise another run owns a different attempt → claim_lost.
    const { data: freshRow } = await db
      // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
      .from("email_retry_content")
      .select("claimed_attempt, completed_attempt")
      .eq("email_log_id", email_log_id)
      .maybeSingle();
    const fresh = freshRow as { claimed_attempt?: number; completed_attempt?: number | null } | null;
    const claimedNow = fresh?.claimed_attempt ?? -1;
    const completedNow = fresh?.completed_attempt ?? -1;
    if (completedNow >= attempt) return "claim_lost";
    if (claimedNow !== attempt) return "claim_lost";
  }

  const tenant = await loadTenantForSend(db, tenant_id);
  if (!tenant) return "tenant_missing";

  // Pattern-14: sendEmail is memoized in its OWN step boundary (keyed by
  // attempt), separate from the last_send_log_id write below. Without this,
  // a whole-function retry that re-enters after a successful send but before
  // completed_attempt lands would re-invoke sendEmail — the Resend
  // Idempotency-Key dedupes only the vendor delivery, not sendEmail's own
  // email_log INSERT + sent-counter bump, so an un-stepped re-run orphans a
  // duplicate row/metric. The record write is a SEPARATE step (#1832) so a
  // transient DB error there retries only the record, never re-invoking the
  // already-memoized send.
  const result = await runStep(`send:${email_log_id}:${attempt}`, () =>
    sendEmail({
      db,
      tenant,
      to: content.to_email,
      subject: content.subject,
      template_id: content.template_id,
      category: content.email_category as EmailCategory,
      html: content.html,
      // Deterministic per attempt: dedupes the Resend DELIVERY only (#23) — the
      // email_log row + sent counter this call writes are NOT deduped by the key;
      // completed_attempt (written below, after scheduleNext) is what keeps a
      // finished attempt from re-running and orphaning a row.
      idempotencyKey: `soft-retry:${email_log_id}:${attempt}`,
      // Mark as a re-send: no new retry chain, no new stored payload.
      retry_of: email_log_id,
      ...(content.reply_to ? { reply_to: content.reply_to } : {}),
      ...(content.related_booking_id ? { related_booking_id: content.related_booking_id } : {}),
      ...(content.related_group_id ? { related_group_id: content.related_group_id } : {}),
      ...(content.user_id ? { user_id: content.user_id } : {}),
      ...(content.contact_id ? { contact_id: content.contact_id } : {}),
    }),
  );

  if (result.status === "sent" && result.email_log_id) {
    // Record the re-send row so the next attempt reads its delivery status.
    // A second, independent step: if this DB write throws, only THIS step
    // retries — the send above stays memoized, so retrying never re-sends.
    await runStep(`record-send-log:${email_log_id}:${attempt}`, () =>
      safeAwait(
        db
          // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
          .from("email_retry_content")
          .update({ last_send_log_id: result.email_log_id })
          .eq("email_log_id", email_log_id),
        "email_retry_content.update.last_send_log_id",
      ),
    );
  }
  // "rate_limited" / "failed" don't update last_send_log_id (no new row landed);
  // we still advance the chain so a later attempt can try again.

  if (result.status === "suppressed") {
    // The address is already blocked — nothing more to do.
    await purgeContent(db, email_log_id);
    return "send_suppressed";
  }

  await scheduleNext({ email_log_id, tenant_id, attempt: attempt + 1 });
  // Completion marker — written LAST, only once the next attempt is scheduled. A
  // re-entrant duplicate of this attempt then reads completed_attempt >= attempt
  // and returns claim_lost instead of re-sending. Ordering is load-bearing: a
  // crash before scheduleNext leaves completed_attempt < attempt, preserving the
  // crash-resume path above.
  await safeAwait(
    db
      // d091-allow:service-role-tenant email_log_id is the globally-unique PK; a retry-content row is single-tenant by construction (FK to email_log), so PK-scoped access is not cross-tenant.
      .from("email_retry_content")
      .update({ completed_attempt: attempt })
      .eq("email_log_id", email_log_id),
    "email_retry_content.update.completed_attempt",
  );
  return "resent";
}
