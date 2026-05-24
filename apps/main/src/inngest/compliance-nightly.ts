// §15.13 — Nightly compliance cron running at 04:00 UTC.
//
// Two jobs:
//   1. ICA version check: if latest legal_documents ICA version > tenant's last
//      accepted version, set requires_ica_reacceptance = true.
//      TODO(prompt-17): legal_documents / legal_consents tables land in §17.
//      Until then, this check is a no-op stub logged for traceability.
//
//   2. Inactivity nudges: at 30/60/90 days write tenant_inactivity_nudges and
//      send email template. At 180 days: suspend tenant.
//
// 180-day inactivity → suspend is the shipped behavior per §15.13.
// Auto-downgrade is deferred to Phase 1. See MEMORY D-049.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { excludeNonPayingPastGrace } from "@/lib/billing/exclude-non-paying";

const NUDGE_LEVELS: { days: number; level: "30d" | "60d" | "90d" | "180d" }[] = [
  { days: 30,  level: "30d"  },
  { days: 60,  level: "60d"  },
  { days: 90,  level: "90d"  },
  { days: 180, level: "180d" },
];

export const complianceNightly = inngest.createFunction(
  {
    id: "compliance-nightly",
    triggers: [{ cron: "0 4 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();
    const now = new Date();

    // ── ICA version check ──────────────────────────────────────────────────
    // TODO(prompt-17): query legal_documents for latest ica_subhost version and
    // compare against legal_consents for each active tenant. Until §17 lands,
    // log a no-op.
    console.info("[compliance-nightly] ICA version check: stub (awaiting §17)");

    // ── Active tenants ─────────────────────────────────────────────────────
    const { data: tenantsRaw, error: tenantErr } = await db
      .from("tenants")
      .select("id, status, requires_ica_reacceptance, subscription_status, non_paying_since")
      .eq("status", "active");

    if (tenantErr) {
      console.error("[compliance-nightly] Failed to fetch tenants: %s", tenantErr.message);
      return;
    }

    // §15.16 — skip past-grace tenants. Inactivity nudges go to PAYING
    // customers (the spec change captured in PR #121); past-grace is its
    // own gate handled by the middleware redirect.
    const tenants = excludeNonPayingPastGrace(
      (tenantsRaw ?? []) as Array<{
        id: string;
        status: string;
        requires_ica_reacceptance?: boolean;
        subscription_status: string | null;
        non_paying_since: string | null;
      }>,
    );

    for (const tenant of tenants) {
      await checkInactivity(db, tenant.id, now);
    }
  },
);

async function checkInactivity(
  db: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  now: Date,
): Promise<void> {
  // Determine last activity: use MAX(created_at) across conversations + bookings.
  const [convResult, bookingResult] = await Promise.all([
    db
      .from("conversations")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1),
    db
      .from("bookings")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const dates = [
    convResult.data?.[0]?.created_at,
    bookingResult.data?.[0]?.created_at,
  ].filter(Boolean).map((d) => new Date(d!));

  if (dates.length === 0) {
    // No activity ever recorded — use epoch as last activity.
    // This means freshly-approved tenants won't immediately get nudged;
    // they get nudged only if they haven't done ANYTHING in 30 days.
    return;
  }

  const lastActivity = new Date(Math.max(...dates.map((d) => d.getTime())));
  const daysSinceActivity = (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);

  for (const { days, level } of NUDGE_LEVELS) {
    if (daysSinceActivity < days) continue;

    // Check if we already sent this nudge level.
    const { data: existing } = await db
      .from("tenant_inactivity_nudges")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("nudge_level", level)
      .maybeSingle();

    if (existing) continue;

    // Write nudge record.
    await db.from("tenant_inactivity_nudges").insert({
      tenant_id: tenantId,
      nudge_level: level,
      sent_at: now.toISOString(),
    });

    console.info("[compliance-nightly] Nudge level=%s sent for tenant=%s (days_inactive=%d)", level, tenantId, Math.floor(daysSinceActivity));

    // TODO(notifications): send email template for nudge level.

    // At 180 days: suspend the tenant.
    if (level === "180d") {
      await db.from("tenants").update({
        status: "suspended",
        suspended_at: now.toISOString(),
        suspended_reason: "inactivity_180d",
      }).eq("id", tenantId);

      console.info("[compliance-nightly] Tenant=%s suspended due to 180-day inactivity", tenantId);
    }

    // Only apply the most severe applicable nudge per run.
    break;
  }
}
