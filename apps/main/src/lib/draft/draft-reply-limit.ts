// #904 — per-member daily cap on draft generations.
//
// Backstop, not the meter (same posture as the TA chat cap, D-195): tenant
// spend is governed by the abuse state machine via the instrumented wrappers.
// Drafts persist no conversations/messages, so the count source is
// ai_call_log (purpose='draft_reply'), which every generation writes.

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_DAILY_CAP = 100;

export type DraftLimitDecision =
  | { allowed: true; current_count: number; cap: number }
  | { allowed: false; current_count: number; cap: number; reason: "cap" | "count_unavailable" };

export async function enforceDraftReplyLimit(
  db: SupabaseClient,
  args: { tenant_id: string; user_id: string },
): Promise<DraftLimitDecision> {
  // Tuning knob — read failure falls back to the default (not the enforcement read).
  const { data: capRow } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "draft_reply_daily_cap")
    .maybeSingle();
  const rawCap = Number((capRow as { value?: unknown } | null)?.value);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : DEFAULT_DAILY_CAP;

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from("ai_call_log")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", args.tenant_id)
    .eq("user_id", args.user_id)
    .eq("purpose", "draft_reply")
    .gte("created_at", since.toISOString());

  // Fail CLOSED — permitting on a failed count would run uncapped.
  if (error || count === null) {
    console.error(
      `[draft-reply] daily-cap count failed (tenant=${args.tenant_id}): ${error?.message ?? "null count"}`,
    );
    return { allowed: false, current_count: 0, cap, reason: "count_unavailable" };
  }
  if (count >= cap) return { allowed: false, current_count: count, cap, reason: "cap" };
  return { allowed: true, current_count: count, cap };
}
