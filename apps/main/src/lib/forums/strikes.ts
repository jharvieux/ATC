// §19.9 — Forum strike recording and pattern enforcement.
//
// All strike pattern outcomes are recommendations, not automatic bans.
// Coordinator has final say per spec §19.9.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

export type StrikeKind = "ai_hidden" | "coordinator_hidden";

export interface StrikeCheckResult {
  auto_muted: boolean;
  coordinator_review_prompt: boolean;
  recommend_removal: boolean;
}

export async function recordStrike(
  db: SupabaseClient,
  {
    user_id,
    forum_id,
    tenant_id,
    message_id,
    kind,
  }: {
    user_id: string;
    forum_id: string;
    tenant_id: string;
    message_id: string | null;
    kind: StrikeKind;
  },
): Promise<void> {
  await safeAwait(db.from("forum_strikes").insert({ user_id, forum_id, tenant_id, message_id, strike_kind: kind }), "forum_strikes.insert");
}

export async function checkStrikePatterns(
  db: SupabaseClient,
  {
    user_id,
    forum_id,
    tenant_id,
  }: {
    user_id: string;
    forum_id: string;
    tenant_id: string;
  },
): Promise<StrikeCheckResult> {
  const now = new Date();
  const window24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // AI-hidden strikes within last 24h
  const { data: recent } = await db
    .from("forum_strikes")
    .select("id")
    .eq("user_id", user_id)
    .eq("forum_id", forum_id)
    .eq("strike_kind", "ai_hidden")
    .gte("created_at", window24h.toISOString());

  const aiHiddenLast24h = (recent ?? []).length;

  // Auto-mute at 3 ai_hidden within 24h
  if (aiHiddenLast24h >= 3) {
    const muteUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await safeAwait(db
      .from("forum_user_state")
      .upsert(
        {
          forum_id,
          user_id,
          tenant_id,
          is_muted: true,
          muted_until: muteUntil.toISOString(),
          mute_reason: "auto_three_ai_hidden_24h",
        },
        { onConflict: "forum_id,user_id" },
      ), "forum_user_state.upsert");
    return { auto_muted: true, coordinator_review_prompt: false, recommend_removal: false };
  }

  // Cumulative coordinator_hidden strikes
  const { data: coordStrikes } = await db
    .from("forum_strikes")
    .select("id")
    .eq("user_id", user_id)
    .eq("forum_id", forum_id)
    .eq("strike_kind", "coordinator_hidden");

  const coordinatorHiddenCumulative = (coordStrikes ?? []).length;

  // All cumulative strikes
  const { data: allStrikes } = await db
    .from("forum_strikes")
    .select("id")
    .eq("user_id", user_id)
    .eq("forum_id", forum_id);

  const totalCumulative = (allStrikes ?? []).length;

  return {
    auto_muted: false,
    coordinator_review_prompt: coordinatorHiddenCumulative >= 5,
    recommend_removal: totalCumulative >= 10,
  };
}
