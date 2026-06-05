// Issue #700 — Auto-suspend tenants stuck in onboarding.
//
// Background: `derivePaymentState` early-returns `isPaying: true` for any
// tenant in status='onboarding' (apps/main/src/lib/billing/payment-state.ts).
// The assumption was that onboarding leads to active+paying quickly, but
// nothing actually enforces that. A SaaS customer who signs up but never
// completes Stripe checkout stays in onboarding indefinitely and can keep
// using paid features (chat, RAG, etc.) for free.
//
// This sweeper closes the abuse vector: nightly cron flips
// status='onboarding' → 'suspended' for tenants that have been in
// onboarding for more than STALE_ONBOARDING_DAYS without progressing
// past the early stages.
//
// Carve-outs:
//   • is_platform_internal=true tenants are exempt (#699 — Booking, etc.)
//   • Tenants at onboarding_stage='review_submitted' are exempt — they've
//     done their part and are awaiting platform-admin review. Suspending
//     them would punish the customer for an internal SLA failure.
//   • Tenants at onboarding_stage='complete' are exempt (shouldn't happen
//     with status='onboarding' but the row could exist mid-webhook-race).

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";

// 14 days from signup. Short enough to deter the abuse vector, long
// enough that legitimate customers who take their time setting up
// don't get cut off mid-flow. Platform admins can manually re-activate
// any tenant suspended by mistake.
const STALE_ONBOARDING_DAYS = 14;

const EXEMPT_STAGES = ["review_submitted", "complete"] as const;

export const onboardingStaleSuspend = inngest.createFunction(
  {
    id: "onboarding-stale-suspend",
    triggers: [{ cron: "15 4 * * *" }], // daily at 04:15 UTC
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "tenant_suspension_processing",
        operation: "onboarding_stale_suspend",
        reason_detail: `automated_suspension_after_${STALE_ONBOARDING_DAYS}d_in_onboarding`,
      },
      async (db, recordQuery) => {
        const cutoff = new Date(
          Date.now() - STALE_ONBOARDING_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();

        const { data: stale, error } = await db
          .from("tenants")
          .select("id, slug, onboarding_stage, created_at")
          .eq("status", "onboarding")
          .eq("is_platform_internal", false)
          .lt("created_at", cutoff)
          .not("onboarding_stage", "in", `(${EXEMPT_STAGES.map((s) => `"${s}"`).join(",")})`)
          .limit(500);
        if (error) {
          console.error("[onboarding-stale-suspend] tenants lookup failed:", error.message);
          return { ok: false, error: error.message };
        }
        const rows = (stale ?? []) as Array<{
          id: string;
          slug: string;
          onboarding_stage: string | null;
          created_at: string;
        }>;
        recordQuery({ op: "select", table: "tenants", row_count: rows.length });

        let suspended = 0;
        for (const t of rows) {
          // Suspend explicitly via safeAwaitRowCount-style return so we can
          // tell if the CAS-shaped guard (status='onboarding') matched. A
          // tenant that finished onboarding between the SELECT and this
          // UPDATE will return 0 rows and we don't suspend them.
          const { data: updated } = await db
            .from("tenants")
            .update({ status: "suspended" })
            .eq("id", t.id)
            .eq("status", "onboarding")
            .select("id");
          if ((updated ?? []).length === 1) {
            suspended++;
            console.info(
              "[onboarding-stale-suspend] suspended tenant=%s slug=%s stage=%s created_at=%s",
              t.id, t.slug, t.onboarding_stage ?? "null", t.created_at,
            );
            // Audit + ops trail. Platform admins can re-activate via the
            // existing admin tenants surface if a legitimate customer got
            // caught by the sweep.
            await safeAwait(
              db.from("audit_log").insert({
                tenant_id: t.id,
                actor_user_id: null,
                actor_type: "system",
                action: "tenant.auto_suspended_stale_onboarding",
                resource_type: "tenant",
                resource_id: t.id,
                changes: {
                  onboarding_stage: t.onboarding_stage,
                  created_at: t.created_at,
                  stale_threshold_days: STALE_ONBOARDING_DAYS,
                  cron_id: "onboarding-stale-suspend",
                },
              }),
              "audit_log.insert",
            );
          }
        }

        return { ok: true, candidates: rows.length, suspended };
      },
    );
  },
);
