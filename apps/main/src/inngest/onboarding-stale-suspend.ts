// Issue #700 — Auto-suspend tenants stuck in onboarding.
//
// Background: `derivePaymentState` early-returns `isPaying: true` for any
// tenant in status='onboarding' (apps/main/src/lib/billing/payment-state.ts).
// The assumption was that onboarding leads to active+paying quickly, but
// nothing actually enforced that. A SaaS customer who signs up but never
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

        // Throw on DB-error so Inngest's automated retry kicks in for
        // transient failures. Returning {ok:false} would silently mark
        // the run "successful" and skip the retry — abuse keeps running.
        const stale = await safeAwait(
          db
            .from("tenants")
            .select("id, slug, onboarding_stage, created_at")
            .eq("status", "onboarding")
            .eq("is_platform_internal", false)
            .lt("created_at", cutoff)
            // PostgREST .not(col, "in", "(a,b)") expects bare comma-
            // separated tokens. Quoting the values (e.g. "(\"a\",\"b\")")
            // matches strings that literally contain the quote
            // characters, so neither carve-out would fire — protected
            // tenants would get suspended.
            .not("onboarding_stage", "in", `(${EXEMPT_STAGES.join(",")})`)
            .limit(500),
          "tenants.select.stale_onboarding_candidates",
        );
        const rows = (stale ?? []) as Array<{
          id: string;
          slug: string;
          onboarding_stage: string | null;
          created_at: string;
        }>;
        recordQuery({ op: "select", table: "tenants", row_count: rows.length });

        let suspended = 0;
        for (const t of rows) {
          // CAS-guarded transition (.eq("status", "onboarding") on the
          // UPDATE) so a tenant that finished onboarding between the
          // SELECT above and this UPDATE doesn't get suspended.
          //
          // safeAwait unwraps {data, error} and THROWS on truthy error.
          // We CAN'T use the manual `{ data: updated }` destructure +
          // length check pattern because a transient DB failure would
          // look identical to a CAS loss (both produce `updated` empty
          // or undefined), silently skipping the tenant with no log,
          // no audit, no metric — and the returned `suspended` count
          // would lie about completeness.
          //
          // Crash window: if the process dies between this UPDATE and
          // the audit_log INSERT below, the tenant ends up suspended
          // with no audit row. On the next firing the CAS guard sees
          // status='suspended' (not 'onboarding') and skips the row, so
          // no re-suspension and no retroactive audit. Acceptable
          // because the console.info on this line still fires before
          // the crash, so the suspend is observable in runtime logs.
          const updated = (await safeAwait(
            db
              .from("tenants")
              .update({ status: "suspended" })
              .eq("id", t.id)
              .eq("status", "onboarding")
              .select("id"),
            "tenants.update.auto_suspend_stale_onboarding",
          )) as Array<{ id: string }> | null;
          if (updated && updated.length === 1) {
            suspended++;
            console.info(
              "[onboarding-stale-suspend] suspended tenant=%s slug=%s stage=%s created_at=%s",
              t.id, t.slug, t.onboarding_stage ?? "null", t.created_at,
            );
            await safeAwait(
              db.from("audit_log").insert({
                tenant_id: t.id,
                actor_user_id: null,
                actor_type: "system",
                action: "tenant.auto_suspended_stale_onboarding",
                resource_type: "tenant",
                resource_id: t.id,
                changes: {
                  slug: t.slug,
                  onboarding_stage: t.onboarding_stage,
                  created_at: t.created_at,
                  stale_threshold_days: STALE_ONBOARDING_DAYS,
                  cron_id: "onboarding-stale-suspend",
                },
              }),
              "audit_log.insert.auto_suspend_stale_onboarding",
            );
          }
        }

        return { ok: true, candidates: rows.length, suspended };
      },
    );
  },
);
