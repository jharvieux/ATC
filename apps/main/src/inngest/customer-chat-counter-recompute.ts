// §24.9 — Nightly recompute of customer_chat_counters from the messages table.
//
// Safety net for drift. For each existing counter row, recounts user messages
// in the rolling window (default 30d) and resets current_count.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — each (user_id, tenant_id) recompute is an independent
// read-then-update of its own counter row.
const RECOMPUTE_CONCURRENCY = 20;

// #1994 — page below any plausible PostgREST db-max-rows setting (historical
// default 1000) so the row list is never silently truncated by the server.
// Ordered by the PK (user_id, tenant_id) rather than last_message_at: those
// columns are immutable, so a row can't shift across a page boundary mid-scan
// the way it could on the mutable last_message_at the CAS above races against.
const RECOMPUTE_PAGE_SIZE = 1000;

export const customerChatCounterRecompute = inngest.createFunction(
  {
    id: "customer-chat-counter-recompute",
    triggers: [{ cron: "30 4 * * *" }], // nightly 04:30 UTC (after the anon cleanup)
  },
  async () => {
    const svc = createServiceRoleClient();
    const windowDays = Number(process.env.CUSTOMER_CHAT_WINDOW_DAYS ?? 30);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const targets: Array<{
      user_id: string;
      tenant_id: string;
      last_message_at: string | null;
    }> = [];
    // serial-await-ok: each page's existence depends on whether the prior
    // page came back full — the offset for page N+1 isn't known until page
    // N resolves, so this can't be parallelized (unlike the per-row work
    // below, which runs through mapWithConcurrency).
    for (let offset = 0; ; offset += RECOMPUTE_PAGE_SIZE) {
      const { data: page, error } = await svc
        .from("customer_chat_counters")
        .select("user_id, tenant_id, last_message_at")
        .order("user_id", { ascending: true })
        .order("tenant_id", { ascending: true })
        .range(offset, offset + RECOMPUTE_PAGE_SIZE - 1);
      if (error) {
        // Fail-closed on the row list itself: stop paging rather than risk an
        // infinite loop or treating a transient error as "table exhausted".
        // Rows already collected still get recomputed below.
        console.error("[customer-chat-counter-recompute] row list page failed, stopping", {
          offset,
        });
        break;
      }
      if (!page || page.length === 0) break;
      targets.push(...page);
      if (page.length < RECOMPUTE_PAGE_SIZE) break;
    }
    await mapWithConcurrency(targets, RECOMPUTE_CONCURRENCY, async (row) => {
      const { count: msgCount, error } = await svc
        .from("messages")
        .select("id, conversations!inner(user_id, tenant_id)", { count: "exact", head: true })
        .eq("role", "user")
        .gte("created_at", since)
        .eq("conversations.user_id", row.user_id)
        .eq("conversations.tenant_id", row.tenant_id);
      if (error) {
        // Fail-closed: a bad count must never overwrite a good counter with 0
        // and let a heavy user bypass their cap. Skip the write; next night's
        // recompute corrects it.
        console.error("[customer-chat-counter-recompute] count failed, skipping row", {
          user_id: row.user_id,
          tenant_id: row.tenant_id,
        });
        return;
      }
      const count = msgCount ?? 0;

      // CAS on last_message_at (#1975). increment_customer_chat_count bumps
      // last_message_at = NOW() on every live increment, so guarding the write
      // on the snapshot we read means a concurrent increment (which moved the
      // timestamp) matches zero rows here — its fresh count wins instead of
      // being clobbered by this slightly-stale recompute. Drift correction
      // retries next night. Rows are only ever created by the RPC (which sets
      // last_message_at), but guard the null case defensively anyway.
      const guarded = svc
        .from("customer_chat_counters")
        .update({ current_count: count })
        .eq("user_id", row.user_id)
        .eq("tenant_id", row.tenant_id);
      const cas = row.last_message_at === null
        ? guarded.is("last_message_at", null)
        : guarded.eq("last_message_at", row.last_message_at);
      const updated = await safeAwait(
        cas.select("user_id"),
        "customer_chat_counters.update",
      );
      if (!updated || updated.length === 0) {
        console.info("[customer-chat-counter-recompute] concurrent increment, skipping row", {
          user_id: row.user_id,
          tenant_id: row.tenant_id,
        });
      }
    });
    return { processed: targets.length };
  },
);
