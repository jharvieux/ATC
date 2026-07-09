// §19.9 — Forum strike recording and pattern enforcement.
//
// All strike pattern outcomes are recommendations, not automatic bans.
// Coordinator has final say per spec §19.9.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { MessageAuthor } from "@/lib/forums/post-message";

export type StrikeKind = "ai_hidden" | "coordinator_hidden";

export interface StrikeCheckResult {
  auto_muted: boolean;
  coordinator_review_prompt: boolean;
  recommend_removal: boolean;
}

export async function recordStrike(
  db: SupabaseClient,
  {
    author,
    forum_id,
    tenant_id,
    message_id,
    kind,
  }: {
    author: MessageAuthor;
    forum_id: string;
    tenant_id: string;
    message_id: string | null;
    kind: StrikeKind;
  },
): Promise<void> {
  await safeAwait(db.from("forum_strikes").insert({ ...author, forum_id, tenant_id, message_id, strike_kind: kind }), "forum_strikes.insert");
}

export async function checkStrikePatterns(
  db: SupabaseClient,
  {
    author,
    forum_id,
    tenant_id,
  }: {
    author: MessageAuthor;
    forum_id: string;
    tenant_id: string;
  },
): Promise<StrikeCheckResult> {
  const now = new Date();
  const window24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // #1572 — forum_strikes/forum_user_state mirror forum_messages'
  // user_id/invitation_id author-XOR (migration
  // 20260709105548_forum_strikes_guest_authors.sql), so a guest's author
  // column keys strikes/mutes the same way a member's does.
  const [col, val]: ["user_id" | "invitation_id", string] =
    "user_id" in author ? ["user_id", author.user_id] : ["invitation_id", author.invitation_id];

  // AI-hidden strikes within last 24h
  const { data: recent } = await db
    .from("forum_strikes")
    .select("id")
    .eq(col, val)
    .eq("forum_id", forum_id)
    .eq("tenant_id", tenant_id)
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
          ...author,
          tenant_id,
          is_muted: true,
          muted_until: muteUntil.toISOString(),
          mute_reason: "auto_three_ai_hidden_24h",
        },
        { onConflict: col === "user_id" ? "forum_id,user_id" : "forum_id,invitation_id" },
      ), "forum_user_state.upsert");
    return { auto_muted: true, coordinator_review_prompt: false, recommend_removal: false };
  }

  // Cumulative coordinator_hidden strikes
  const { data: coordStrikes } = await db
    .from("forum_strikes")
    .select("id")
    .eq(col, val)
    .eq("forum_id", forum_id)
    .eq("tenant_id", tenant_id)
    .eq("strike_kind", "coordinator_hidden");

  const coordinatorHiddenCumulative = (coordStrikes ?? []).length;

  // All cumulative strikes
  const { data: allStrikes } = await db
    .from("forum_strikes")
    .select("id")
    .eq(col, val)
    .eq("forum_id", forum_id)
    .eq("tenant_id", tenant_id);

  const totalCumulative = (allStrikes ?? []).length;

  return {
    auto_muted: false,
    coordinator_review_prompt: coordinatorHiddenCumulative >= 5,
    recommend_removal: totalCumulative >= 10,
  };
}
