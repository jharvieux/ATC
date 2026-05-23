// §27.6 — Per-dimension enforcement behaviors.
//
// AI cost enforcement is handled inside the call wrapper (selectModelForPurpose
// for soft1/soft2 model downgrade). HARD-state blocking lives at the chat
// handler — it checks getAiCostState before calling the wrapper.
//
// Chat volume / email volume / group invite enforcement helpers below are
// called by the respective handlers to decide queue/delay/refuse.
//
// State columns are populated by the state-machine; this file reads them
// and translates into action.

import type { SupabaseClient } from "@supabase/supabase-js";

export type LimitState = "ok" | "soft1" | "soft2" | "hard";

export interface EnforcementDecision<Extra = Record<string, unknown>> {
  state: LimitState;
  action: "proceed" | "delay" | "queue_admin_approval" | "refuse" | "downgrade";
  delay_ms?: number;
  reason?: string;
  extra?: Extra;
}

const SOFT1_EMAIL_DELAY_MS = 5 * 60 * 1000;       // 5 min
const SOFT2_EMAIL_DELAY_MS = 30 * 60 * 1000;      // 30 min
const SOFT1_CHAT_DELAY_MS = 2500;
const SOFT2_CHAT_DELAY_MS = 7000;
const SOFT2_GROUP_INVITE_BATCH_THRESHOLD = 20;

async function loadMonthlyState(
  db: SupabaseClient,
  tenant_id: string,
  state_col: string,
): Promise<LimitState> {
  const { data } = await db
    .from("tenant_usage_metrics")
    .select(`id, ai_cost_limit_state, chat_volume_limit_state, email_volume_limit_state, group_invite_limit_state`)
    .eq("tenant_id", tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as unknown as Record<string, string> | null;
  return (row?.[state_col] as LimitState) ?? "ok";
}

// ── AI cost ─────────────────────────────────────────────────────────

export async function getAiCostState(db: SupabaseClient, tenant_id: string): Promise<LimitState> {
  return loadMonthlyState(db, tenant_id, "ai_cost_limit_state");
}

export const AI_COST_HARD_FALLBACK =
  "Our system is over capacity for the moment — a human will be in touch.";

/**
 * Chat handler calls this BEFORE invoking the wrapper. If state is hard,
 * surface the fallback message and skip the call entirely.
 */
export async function decideAiCostEnforcement(
  db: SupabaseClient,
  tenant_id: string,
): Promise<EnforcementDecision<{ fallback_text?: string }>> {
  const state = await getAiCostState(db, tenant_id);
  if (state === "hard") {
    return {
      state,
      action: "refuse",
      reason: "ai_cost_hard_cutoff",
      extra: { fallback_text: AI_COST_HARD_FALLBACK },
    };
  }
  // soft1/soft2 downgrade is handled inside the wrapper via selectModelForPurpose.
  return { state, action: state === "ok" ? "proceed" : "downgrade" };
}

// ── Email volume ────────────────────────────────────────────────────

export async function decideEmailVolumeEnforcement(
  db: SupabaseClient,
  tenant_id: string,
  category: "transactional" | "marketing" | "pre_cruise" | "group_invitation" | "travel_news",
): Promise<EnforcementDecision> {
  const state = await loadMonthlyState(db, tenant_id, "email_volume_limit_state");
  if (state === "ok") return { state, action: "proceed" };
  if (state === "soft1") return { state, action: "delay", delay_ms: SOFT1_EMAIL_DELAY_MS };
  if (state === "soft2") return { state, action: "delay", delay_ms: SOFT2_EMAIL_DELAY_MS };
  // hard — transactional still goes through, others refused
  if (category === "transactional") return { state, action: "proceed", reason: "transactional_bypass" };
  return { state, action: "refuse", reason: "email_volume_hard" };
}

/**
 * §27.4.4 side-channel: the email-bounce-rate cron flips this flag
 * regardless of monthly state. Returns true if non-transactional sends
 * should be refused right now.
 */
export async function isEmailPausedForBounceRate(
  db: SupabaseClient,
  tenant_id: string,
): Promise<boolean> {
  const { data } = await db
    .from("tenant_settings")
    .select("email_paused_due_to_bounce_rate")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  return Boolean((data as { email_paused_due_to_bounce_rate?: boolean } | null)?.email_paused_due_to_bounce_rate);
}

// ── Chat volume ─────────────────────────────────────────────────────

export async function decideChatVolumeEnforcement(
  db: SupabaseClient,
  tenant_id: string,
): Promise<EnforcementDecision> {
  const state = await loadMonthlyState(db, tenant_id, "chat_volume_limit_state");
  if (state === "ok") return { state, action: "proceed" };
  if (state === "soft1") return { state, action: "delay", delay_ms: SOFT1_CHAT_DELAY_MS };
  if (state === "soft2") return { state, action: "delay", delay_ms: SOFT2_CHAT_DELAY_MS, reason: "high_load_variant" };
  return { state, action: "refuse", reason: "chat_volume_hard" };
}

// ── Group invite ────────────────────────────────────────────────────

export interface GroupInviteEnforcementInput {
  db: SupabaseClient;
  tenant_id: string;
  batch_invitee_count: number;
  confirm_received?: boolean;
}

export async function decideGroupInviteEnforcement(
  input: GroupInviteEnforcementInput,
): Promise<EnforcementDecision> {
  const state = await loadMonthlyState(input.db, input.tenant_id, "group_invite_limit_state");
  if (state === "ok") return { state, action: "proceed" };
  if (state === "hard") return { state, action: "refuse", reason: "group_invite_monthly_hard" };
  if (state === "soft1") {
    // Require explicit confirm:true in the body.
    if (input.confirm_received) return { state, action: "proceed" };
    return { state, action: "refuse", reason: "soft1_requires_confirm" };
  }
  // soft2: above + admin pre-approval on batches > 20.
  if (input.batch_invitee_count > SOFT2_GROUP_INVITE_BATCH_THRESHOLD) {
    return { state, action: "queue_admin_approval", reason: "soft2_batch_over_20" };
  }
  if (input.confirm_received) return { state, action: "proceed" };
  return { state, action: "refuse", reason: "soft2_requires_confirm" };
}
