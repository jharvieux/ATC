// §21.10.1 — Daily ESTIMATE quote auto-expiry sweep.
//
// Finds quotes that:
//   - have price_kind = 'estimate'
//   - were priced more than QUOTE_ESTIMATE_VALIDITY_DAYS ago
//   - are still in status='sent' and unaccepted
// and transitions them to status='expired'. A follow-up email with a
// "request fresh quote" CTA is logged — TODO(bp23-email): wire to Resend when the
// pre-cruise email pipeline lands in BP23 — same Resend integration).
//
// Cron: daily at 02:00 UTC. Cheap query; the partial index
// quotes_estimate_expiry_sweep_idx (migration 20260531000000) covers it.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const DEFAULT_VALIDITY_DAYS = 7;

export const quoteEstimateExpirySweep = inngest.createFunction(
  {
    id: "quote-estimate-expiry-sweep",
    triggers: [{ cron: "0 2 * * *" }],
  },
  async () => {
    const validityDays = Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? DEFAULT_VALIDITY_DAYS);
    const cutoff = new Date(Date.now() - validityDays * 24 * 60 * 60 * 1000);

    const db = createServiceRoleClient();
    const { data: stale, error } = await db
      .from("quotes")
      .select("id, tenant_id, contact_id, user_id")
      .eq("price_kind", "estimate")
      .eq("status", "sent")
      .is("customer_accepted_at", null)
      .lt("priced_at", cutoff.toISOString());

    if (error) {
      console.error("[quote-estimate-expiry-sweep] query failed:", error.message);
      return { expired: 0, error: error.message };
    }

    const rows = (stale ?? []) as Array<{
      id: string;
      tenant_id: string;
      contact_id: string | null;
      user_id: string | null;
    }>;

    if (rows.length === 0) {
      return { expired: 0 };
    }

    const now = new Date().toISOString();
    const { error: updateErr } = await db
      .from("quotes")
      .update({ status: "expired", updated_at: now })
      .in("id", rows.map((r) => r.id));

    if (updateErr) {
      console.error("[quote-estimate-expiry-sweep] update failed:", updateErr.message);
      return { expired: 0, error: updateErr.message };
    }

    // TODO(bp23-email): wire the "request fresh quote" CTA email through the
    // tenant-aware Resend pipeline once §23 ships. Until then, log so the
    // operator sees expiry volume in the function-run dashboard.
    for (const r of rows) {
      console.info(
        `[quote-estimate-expiry-sweep] expired quote=${r.id} tenant=${r.tenant_id} contact=${r.contact_id ?? "—"}`,
      );
    }

    return { expired: rows.length };
  },
);
