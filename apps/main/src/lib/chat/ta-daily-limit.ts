// #902 / D-195 — TA-mode daily message cap.
//
// Backstop, not the meter: tenant AI spend is governed by the abuse-state
// machine (ai_cost_limit_state via the instrumented wrappers); this cap only
// stops one member from draining the tenant's monthly allowance in a burst
// (operator: 200/day default). Counted live from messages⨝conversations —
// no counter table to drift, and TA volume (≤cap/member/day) keeps the
// count query trivial.

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_DAILY_CAP = 200;

export type TaLimitDecision =
  | { allowed: true; current_count: number; cap: number }
  | { allowed: false; current_count: number; cap: number; reason: "cap" | "count_unavailable" };

export async function enforceTaDailyLimit(
  db: SupabaseClient,
  args: { tenant_id: string; user_id: string },
): Promise<TaLimitDecision> {
  // Tunable cap — a read failure here falls back to the default (it's a
  // tuning knob, not the enforcement read).
  const { data: capRow } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "ta_chat_daily_message_cap")
    .maybeSingle();
  const rawCap = Number((capRow as { value?: unknown } | null)?.value);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : DEFAULT_DAILY_CAP;

  // Enforcement read — UTC-day window. Same messages⨝conversations join the
  // customer limit's recount uses, narrowed to TA-audience conversations.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from("messages")
    .select("id, conversations!inner(user_id, tenant_id, audience)", {
      count: "exact",
      head: true,
    })
    .eq("role", "user")
    .gte("created_at", since.toISOString())
    .eq("conversations.user_id", args.user_id)
    .eq("conversations.tenant_id", args.tenant_id)
    .eq("conversations.audience", "tenant_member");

  // Fail CLOSED: if we can't count, we can't prove the member is under cap,
  // and permitting would disable the only stop while #866 leaves the cost
  // state machine unenforced on the streaming path.
  if (error || count === null) {
    console.error(
      `[ta-chat] daily-cap count failed (tenant=${args.tenant_id}): ${error?.message ?? "null count"}`,
    );
    return { allowed: false, current_count: 0, cap, reason: "count_unavailable" };
  }

  if (count >= cap) {
    return { allowed: false, current_count: count, cap, reason: "cap" };
  }
  return { allowed: true, current_count: count, cap };
}
