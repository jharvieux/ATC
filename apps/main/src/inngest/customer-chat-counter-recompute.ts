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

export const customerChatCounterRecompute = inngest.createFunction(
  {
    id: "customer-chat-counter-recompute",
    triggers: [{ cron: "30 4 * * *" }], // nightly 04:30 UTC (after the anon cleanup)
  },
  async () => {
    const svc = createServiceRoleClient();
    const windowDays = Number(process.env.CUSTOMER_CHAT_WINDOW_DAYS ?? 30);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows } = await svc
      .from("customer_chat_counters")
      .select("user_id, tenant_id")
      .limit(5000);

    const targets = (rows ?? []) as Array<{ user_id: string; tenant_id: string }>;
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
      await safeAwait(svc
        .from("customer_chat_counters")
        .update({ current_count: count })
        .eq("user_id", row.user_id)
        .eq("tenant_id", row.tenant_id), "customer_chat_counters.update");
    });
    return { processed: targets.length };
  },
);
