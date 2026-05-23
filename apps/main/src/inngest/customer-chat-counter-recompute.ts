// §24.9 — Nightly recompute of customer_chat_counters from the messages table.
//
// Safety net for drift. For each existing counter row, recounts user messages
// in the rolling window (default 30d) and resets current_count.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

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

    let processed = 0;
    for (const row of (rows ?? []) as Array<{ user_id: string; tenant_id: string }>) {
      const { data: msgs } = await svc
        .from("messages")
        .select("id, conversations!inner(user_id, tenant_id)")
        .eq("role", "user")
        .gte("created_at", since)
        .eq("conversations.user_id", row.user_id)
        .eq("conversations.tenant_id", row.tenant_id);
      const count = Array.isArray(msgs) ? msgs.length : 0;
      await svc
        .from("customer_chat_counters")
        .update({ current_count: count })
        .eq("user_id", row.user_id)
        .eq("tenant_id", row.tenant_id);
      processed++;
    }
    return { processed };
  },
);
