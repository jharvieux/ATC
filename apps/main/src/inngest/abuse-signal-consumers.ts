// §27.10 — Consumers for Part 5 abuse-signal events.
//
// These write to abuse_signals (BP27) when the underlying events fire.
// The actual events were emitted from:
//   • tenant.rag_pii_recurring_pattern_detected — BP22 pii-quarantine-aggregator
//   • chat.anonymous_chat_burst_detected         — BP24 anonymous-limit

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const abuseSignalRagPiiRecurring = inngest.createFunction(
  {
    id: "abuse-signal-consumer-rag-pii-recurring",
    triggers: [{ event: "tenant.rag_pii_recurring_pattern_detected" }],
  },
  async ({ event }) => {
    const svc = createServiceRoleClient();
    const tenant_id = String((event.data as { tenant_id?: string }).tenant_id ?? "");
    if (!tenant_id) return { error: "no_tenant_id" };
    await svc.from("abuse_signals").insert({
      tenant_id,
      signal_kind: "rag_pii_recurring",
      detail: event.data as Record<string, unknown>,
    });
    return { ok: true };
  },
);

export const abuseSignalAnonChatBurst = inngest.createFunction(
  {
    id: "abuse-signal-consumer-anon-chat-burst",
    triggers: [{ event: "chat.anonymous_chat_burst_detected" }],
  },
  async ({ event }) => {
    const svc = createServiceRoleClient();
    const tenant_id = String((event.data as { tenant_id?: string }).tenant_id ?? "");
    if (!tenant_id) return { error: "no_tenant_id" };
    await svc.from("abuse_signals").insert({
      tenant_id,
      signal_kind: "anon_chat_burst",
      detail: event.data as Record<string, unknown>,
    });
    return { ok: true };
  },
);
