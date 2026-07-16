// §15.13 — Nightly compliance cron running at 04:00 UTC.
//
// Two jobs:
//   1. ICA version check: if latest legal_documents ICA version > tenant's last
//      accepted version, set requires_ica_reacceptance = true. Belt-and-
//      suspenders against the publish-time flag (which writes user_consent_pending
//      rows) — catches tenants who somehow slipped through (e.g. signups
//      between publish and flag).
//
//   2. Inactivity reminders: at 30/60/90 days, write tenant_inactivity_nudges
//      AND send the InactivityReminder email pointing the admin at features
//      they're missing and the Help AI.
//
// What this cron does NOT do anymore (policy change from #121):
//   - No 180-day auto-suspend for inactive PAYING tenants. The user's
//     framing: paying customers shouldn't lose access because they're not
//     using the app. The 180d level row stays in NUDGE_LEVELS as a final
//     reminder; the suspend branch is gone.
//   - Past-grace non-paying tenants are skipped here entirely — the
//     middleware redirect + cron filter handle them.

import * as React from "react";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { excludeNonPayingPastGrace } from "@/lib/billing/exclude-non-paying";
import { sendEmail, TENANT_BRANDING_COLUMNS, type EmailSendResult } from "@/lib/email/send";
import { InactivityReminder, type InactivityNudgeLevel } from "@/emails/InactivityReminder";
import { safeAwait } from "@/lib/db/safe-mutation";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — this cron iterates every active tenant with no cap; bounded
// concurrency keeps a platform-wide fan-out from hammering the DB while
// still cutting nightly runtime from O(tenants) sequential round-trips.
const NIGHTLY_CONCURRENCY = 20;

// #1933 — PostgREST caps any single response at ~1000 rows (db-max-rows)
// regardless of a requested .limit(), which would silently truncate the
// tenants/branding reads past the cap: dropped tenants skip their ICA-drift
// check and, worse, their branding row goes missing so the `??
// "platform_resend"` coalescing sends them from the platform domain instead
// of their own. Page in 1000-row windows (same pattern as
// dob-estimate-reprompt-eligible.ts, #1745) so nothing is dropped.
const PAGE = 1000;

type NudgeLevel = "30d" | "60d" | "90d" | "180d";

const NUDGE_LEVELS: { days: number; level: NudgeLevel }[] = [
  { days: 30,  level: "30d"  },
  { days: 60,  level: "60d"  },
  { days: 90,  level: "90d"  },
  { days: 180, level: "180d" },
];

// Only the first three reminders carry an email body — 180d is now a
// log-only final breadcrumb (the cron sees that an admin has been silent
// for half a year; nothing more to say without becoming pushy).
const EMAIL_LEVELS: ReadonlySet<NudgeLevel> = new Set(["30d", "60d", "90d"]);

// Most-severe applicable nudge level for a given inactivity span, or null when
// the tenant is still under the 30-day floor. Walks the levels high→low and
// returns the first whose threshold is met — so a tenant 95 days idle trips
// "90d", never the lower reminders. (checkInactivity acts only on this single
// level: every branch of its old loop returned on the first match.)
export function selectNudgeLevel(daysSinceActivity: number): NudgeLevel | null {
  for (const { days, level } of [...NUDGE_LEVELS].reverse()) {
    if (daysSinceActivity >= days) return level;
  }
  return null;
}

interface TenantContactRow {
  id: string;
  status: string;
  support_email: string | null;
  legal_name: string | null;
  display_name: string | null;
  mailing_address: Record<string, unknown> | null;
  subscription_status: string | null;
  non_paying_since: string | null;
  // #699 — internal tenants bypass the payment gate.
  is_platform_internal?: boolean;
}

// #1740: these live on tenant_branding, NOT tenants. Selecting them from
// tenants errored the whole query, so the cron sent nothing at all.
interface TenantBrandingRow {
  tenant_id: string;
  email_send_pattern: "platform_resend" | "tenant_resend" | null;
  tenant_resend_api_key_encrypted: string | null;
  email_from_address: string | null;
  email_from_name: string | null;
  // #1935 — verified-custom-domain fields; must be read alongside the rest
  // of the branding row so this cron's from-address matches the other four.
  email_from_domain: string | null;
  email_from_domain_verified_at: string | null;
}

// Idempotency: this function has no step.run boundaries and uses
// mapWithConcurrency's fail-fast semantics — one tenant's throw rejects the
// whole batch, so Inngest retries the entire function while other tenants'
// in-flight send/record pairs (checkInactivity, checkIcaVersionDrift) keep
// running detached from that retry. A retried tenant can therefore be
// re-sent; the Resend idempotencyKey on the reminder send (see
// sendReminderEmail) is the backstop that turns a re-sent attempt into a
// dedup no-op instead of a duplicate email. Per-tenant step isolation would
// remove this window entirely but is a bigger design change — tracked
// separately (refs #1934, refs #1971-audit).
export const complianceNightly = inngest.createFunction(
  {
    id: "compliance-nightly",
    triggers: [{ cron: "0 4 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();
    const now = new Date();

    // ── ICA version check ──────────────────────────────────────────────────
    const icaFlagged = await checkIcaVersionDrift(db);
    console.info(
      "[compliance-nightly] ICA version check: flagged %d tenants for re-acceptance",
      icaFlagged,
    );

    // ── Active tenants ─────────────────────────────────────────────────────
    // #1740 — a bare `return` here is what hid the branding-column bug for
    // weeks: the run reported success, so no retry and no failed-run alert
    // while every nightly nudge silently went unsent. Throw so Inngest retries
    // and surfaces the failure. Same for the branding read below.
    const tenantsRaw: TenantContactRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: tenantErr } = await db
        .from("tenants")
        .select(
          "id, status, support_email, legal_name, display_name, mailing_address, " +
          "subscription_status, non_paying_since, is_platform_internal",
        )
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (tenantErr) throw new Error(`tenants.select failed: ${tenantErr.message}`);
      const batch = (page ?? []) as unknown as TenantContactRow[];
      tenantsRaw.push(...batch);
      if (batch.length < PAGE) break;
    }

    // §15.16 — skip past-grace tenants. Inactivity reminders go to PAYING
    // customers; past-grace is the middleware redirect's job.
    const tenants = excludeNonPayingPastGrace(tenantsRaw);

    const tenantIds = tenants.map((t) => t.id);
    const brandingRaw: TenantBrandingRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: brandingErr } = await db
        .from("tenant_branding")
        .select(TENANT_BRANDING_COLUMNS)
        .in("tenant_id", tenantIds.length > 0 ? tenantIds : ["00000000-0000-0000-0000-000000000000"])
        .order("tenant_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (brandingErr) throw new Error(`tenant_branding.select failed: ${brandingErr.message}`);
      const batch = (page ?? []) as unknown as TenantBrandingRow[];
      brandingRaw.push(...batch);
      if (batch.length < PAGE) break;
    }

    const brandingByTenant = new Map<string, TenantBrandingRow>(
      brandingRaw.map((b) => [b.tenant_id, b]),
    );

    // Each tenant's inactivity check is independent — bounded-concurrency
    // fan out instead of one tenant at a time.
    const inactivityResults = await mapWithConcurrency(tenants, NIGHTLY_CONCURRENCY, (tenant) =>
      checkInactivity(db, tenant, brandingByTenant.get(tenant.id) ?? null, now),
    );
    let sentEmails = 0;
    let levelLoggedNoEmail = 0;
    let sendFailures = 0;
    for (const result of inactivityResults) {
      if (result === "email_sent") sentEmails++;
      else if (result === "level_logged_no_email") levelLoggedNoEmail++;
      else if (result === "send_failed") sendFailures++;
    }

    return {
      tenants_processed: tenants.length,
      reminders_sent: sentEmails,
      level_logged_no_email: levelLoggedNoEmail,
      // #1934 — visibility into sends that failed and were left unrecorded
      // (so they retry next run) instead of being silently swallowed.
      send_failed: sendFailures,
      ica_reacceptance_flagged: icaFlagged,
    };
  },
);

/**
 * §17.5 — Find any tenants whose latest accepted `ica_subhost` version is
 * less than the current effective version and flip `requires_ica_reacceptance`.
 * The publish-time flow in /api/admin/legal-docs already writes
 * user_consent_pending rows for affected users; this catches the
 * tenant-level flag for tenants that signed up or migrated after the
 * publish event fired.
 */
async function checkIcaVersionDrift(
  db: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  // Latest current ICA version.
  const { data: latestRows } = await db
    .from("legal_documents")
    .select("version")
    .eq("document_type", "ica_subhost")
    .is("superseded_at", null)
    .order("version", { ascending: false })
    .limit(1);
  const latest = (latestRows ?? [])[0] as { version: number } | undefined;
  if (!latest) return 0;

  // All active tenants not already flagged.
  // #1933 (adjacent instance, same file) — same unbounded-SELECT class as the
  // tenants/branding reads below: past 1000 active tenants this would
  // silently stop flagging drift for the rest. Paginate for the same reason.
  const tenants: Array<{ id: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: tenantErr } = await db
      .from("tenants")
      .select("id")
      .eq("status", "active")
      .eq("requires_ica_reacceptance", false)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (tenantErr) throw new Error(`tenants.select (ica-drift) failed: ${tenantErr.message}`);
    const batch = (page ?? []) as Array<{ id: string }>;
    tenants.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Each tenant's consent check + flag update is independent — bounded
  // concurrency fan out instead of one tenant at a time.
  const flaggedResults = await mapWithConcurrency(
    tenants,
    NIGHTLY_CONCURRENCY,
    async (t) => {
      const { data: consentRows, error: consentErr } = await db
        .from("legal_consents")
        .select("document_version")
        .eq("tenant_id", t.id)
        .eq("document_type", "ica_subhost")
        .eq("action", "accepted")
        .order("acted_at", { ascending: false })
        .limit(1);
      if (consentErr) throw new Error(`legal_consents.select failed for tenant=${t.id}: ${consentErr.message}`);
      const accepted = (consentRows ?? [])[0] as { document_version: number } | undefined;
      const acceptedVersion = accepted?.document_version ?? 0;
      if (acceptedVersion < latest.version) {
        await safeAwait(db
          .from("tenants")
          .update({ requires_ica_reacceptance: true })
          .eq("id", t.id), "tenants.update");
        return true;
      }
      return false;
    },
  );
  return flaggedResults.filter(Boolean).length;
}

type InactivityResult = "no_activity_data" | "below_threshold" | "already_sent" | "email_sent" | "level_logged_no_email" | "send_failed";

async function checkInactivity(
  db: ReturnType<typeof createServiceRoleClient>,
  tenant: TenantContactRow,
  branding: TenantBrandingRow | null,
  now: Date,
): Promise<InactivityResult> {
  // Determine last activity: MAX(created_at) across conversations + bookings.
  const [convResult, bookingResult] = await Promise.all([
    db
      .from("conversations")
      .select("created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(1),
    db
      .from("bookings")
      .select("created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (convResult.error) {
    throw new Error(`conversations.select failed for tenant=${tenant.id}: ${convResult.error.message}`);
  }
  if (bookingResult.error) {
    throw new Error(`bookings.select failed for tenant=${tenant.id}: ${bookingResult.error.message}`);
  }

  const dates = [
    convResult.data?.[0]?.created_at,
    bookingResult.data?.[0]?.created_at,
  ].filter(Boolean).map((d) => new Date(d!));

  if (dates.length === 0) {
    // No activity ever recorded — freshly-approved tenants don't get nudged
    // until they've existed for 30 days without doing anything.
    return "no_activity_data";
  }

  const lastActivity = new Date(Math.max(...dates.map((d) => d.getTime())));
  const daysSinceActivity = (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);

  // Act on the most severe applicable level (avoids sending a 30d reminder to
  // a tenant who's already at 90d). Below the 30d floor → nothing to do.
  const level = selectNudgeLevel(daysSinceActivity);
  if (!level) return "below_threshold";

  // Already sent this level? Skip.
  const { data: existing } = await db
    .from("tenant_inactivity_nudges")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("nudge_level", level)
    .maybeSingle();
  if (existing) return "already_sent";

  if (!EMAIL_LEVELS.has(level)) {
    // 180d — no email, just the breadcrumb below. Replaces the prior
    // auto-suspend behaviour (deliberate policy change — paying tenants
    // don't lose access for inactivity). Nothing async can fail after this
    // point, so recording immediately is safe.
    await recordNudge(db, tenant.id, level, now);
    console.info(
      "[compliance-nightly] Nudge level=%s recorded for tenant=%s (days_inactive=%d)",
      level, tenant.id, Math.floor(daysSinceActivity),
    );
    return "level_logged_no_email";
  }

  if (!tenant.support_email) {
    console.warn(
      "[compliance-nightly] Skipping reminder for tenant=%s — no support_email on row",
      tenant.id,
    );
    await recordNudge(db, tenant.id, level, now);
    return "level_logged_no_email";
  }

  // #1934 — the nudge row used to be written BEFORE this send. A throw or a
  // non-throwing send failure (sendEmail never throws on a Resend error; it
  // returns status:"failed") left the row in place, so the `already_sent`
  // guard above permanently suppressed the retry. Only record the nudge
  // once the send actually succeeds — a failed send leaves nothing behind,
  // so the next nightly run tries again.
  const sendResult = await sendReminderEmail({ db, tenant, branding, level: level as InactivityNudgeLevel, daysSinceActivity });
  if (sendResult.status !== "sent") {
    console.warn(
      "[compliance-nightly] Nudge level=%s NOT recorded for tenant=%s — send status=%s, will retry next run",
      level, tenant.id, sendResult.status,
    );
    return "send_failed";
  }

  await recordNudge(db, tenant.id, level, now);
  console.info(
    "[compliance-nightly] Nudge level=%s recorded for tenant=%s (days_inactive=%d)",
    level, tenant.id, Math.floor(daysSinceActivity),
  );
  return "email_sent";
}

async function recordNudge(
  db: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  level: NudgeLevel,
  now: Date,
): Promise<void> {
  await safeAwait(db.from("tenant_inactivity_nudges").insert({
    tenant_id: tenantId,
    nudge_level: level,
    sent_at: now.toISOString(),
  }), "tenant_inactivity_nudges.insert");
}

async function sendReminderEmail(args: {
  db: ReturnType<typeof createServiceRoleClient>;
  tenant: TenantContactRow;
  branding: TenantBrandingRow | null;
  level: InactivityNudgeLevel;
  daysSinceActivity: number;
}): Promise<EmailSendResult> {
  const { db, tenant, branding, level, daysSinceActivity } = args;
  const appUrl = process.env.MAIN_APP_URL ?? "https://ai-travelconcierge.com";
  const helpUrl = `${appUrl.replace(/\/$/, "")}/help`;
  const unsubscribeUrl = `${appUrl.replace(/\/$/, "")}/api/email/unsubscribe?email=${encodeURIComponent(tenant.support_email!)}&category=marketing`;

  const tenantLegalName = tenant.legal_name ?? tenant.display_name ?? "Your business";
  const businessAddress = formatMailingAddress(tenant.mailing_address);

  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = "<!doctype html>" + renderToStaticMarkup(
    React.createElement(InactivityReminder, {
      branding: {},
      tenant_legal_name: tenantLegalName,
      tenant_business_address: businessAddress,
      recipient_name: tenantLegalName,
      nudge_level: level,
      days_inactive: Math.floor(daysSinceActivity),
      app_url: appUrl,
      help_url: helpUrl,
      unsubscribe_url: unsubscribeUrl,
    }),
  );

  return sendEmail({
    db,
    tenant: {
      id: tenant.id,
      legal_name: tenantLegalName,
      mailing_address: businessAddress,
      email_send_pattern: branding?.email_send_pattern ?? "platform_resend",
      tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
      email_from_address: branding?.email_from_address ?? null,
      email_from_name: branding?.email_from_name ?? null,
      // #1935 — must be forwarded so a verified custom domain is honored the
      // same way it is by the other four crons.
      email_from_domain: branding?.email_from_domain ?? null,
      email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
    },
    to: tenant.support_email!,
    subject: SUBJECT_BY_LEVEL[level],
    template_id: `inactivity_reminder_${level}`,
    category: "marketing",
    html,
    // Keyed on tenant + level so a step retry of this same nudge doesn't
    // double-send; a new level (tenant went quiet longer) gets a new key.
    idempotencyKey: `inactivity_reminder:${tenant.id}:${level}`,
  });
}

const SUBJECT_BY_LEVEL: Record<InactivityNudgeLevel, string> = {
  "30d": "It's been a few weeks — anything we can help with?",
  "60d": "Checking in on your AI Travel Concierge account",
  "90d": "Still here whenever you're ready",
};
