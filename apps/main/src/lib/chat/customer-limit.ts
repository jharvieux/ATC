// §24.9 — Authenticated customer 3-tier chat rate limit.
//
// Per (user_id, tenant_id), rolling 30-day window. Three tiers:
//   Soft1 — persona prompt augmented with gentle nudge (in-character)
//   Soft2 — persona prompt augmented with more direct nudge (in-character)
//   Hard  — AI NOT called; system-spoken message rendered server-side.
//
// Booking bonus: a tenant-future-booking adds N% capacity at every tier
// (computed lazily by resolve_customer_chat_caps SQL function — single
// source of truth).
//
// Cooldowns: Soft1 nudge once per 7 days, Soft2 once per 3 days, to avoid
// nagging at the same customer on every message in a hot tier.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/audit/write";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { safeAwait } from "@/lib/db/safe-mutation";
import { getCachedPlatformSetting } from "@/lib/platform/platform-setting-cache";

export type CustomerLimitDecision =
  | { tier: "below"; resolved: ResolvedCaps; current_count: number }
  | { tier: "soft1"; resolved: ResolvedCaps; current_count: number; persona_augmentation: string }
  | { tier: "soft2"; resolved: ResolvedCaps; current_count: number; persona_augmentation: string }
  | { tier: "hard";  resolved: ResolvedCaps; current_count: number; reset_at: string };

export type ResolvedCaps = {
  soft1_cap: number;
  soft2_cap: number;
  hard_cap: number;
  booking_bonus_percent: number;
};

async function loadPlatformSetting(
  db: SupabaseClient,
  key: string,
  fallback: unknown,
): Promise<unknown> {
  // #1586 — soft-tier persona prompts change weekly-to-never; served from the
  // shared 60s platform_settings cache. Error → fallback (unchanged behavior).
  const { value } = await getCachedPlatformSetting(db, key);
  return value ?? fallback;
}

async function resolveCaps(
  db: SupabaseClient,
  user_id: string,
  tenant_id: string,
): Promise<ResolvedCaps> {
  const { data, error } = await db.rpc("resolve_customer_chat_caps", {
    p_user_id: user_id,
    p_tenant_id: tenant_id,
  });
  if (error || !Array.isArray(data) || data.length === 0) {
    // Fail-closed-ish: fall back to platform defaults from env.
    return {
      soft1_cap: Number(process.env.CUSTOMER_CHAT_SOFT1_CAP ?? 20),
      soft2_cap: Number(process.env.CUSTOMER_CHAT_SOFT2_CAP ?? 30),
      hard_cap:  Number(process.env.CUSTOMER_CHAT_HARD_CAP ?? 40),
      booking_bonus_percent: 0,
    };
  }
  const row = data[0] as ResolvedCaps;
  return row;
}

// Recompute current_count from messages table (safety net + initial seed).
// Used when the counter row doesn't exist or appears stale. Counts only
// USER-sent messages (AI responses don't count) in the rolling window.
// Increment the per-(user, tenant) counter and decide which tier the
// incoming message lands in. Caller is responsible for: if 'hard', NOT
// calling the AI; otherwise running the AI with persona_augmentation
// prepended to the system prompt.
//
// F-sm-01 (#1376): the increment is DB-atomic (increment_customer_chat_count
// RPC — INSERT … ON CONFLICT DO UPDATE … RETURNING, with the rolling-window
// reset folded in). We CONSUME first, then decide the tier against the returned
// post-increment count, so K concurrent requests at hard_cap-1 each get a
// distinct count and exactly one lands on the boundary (non-hard). The old
// SELECT→compute→UPDATE path let them all read the stale count and pass,
// bypassing the hard ceiling. A consequence of consume-then-check: a blocked
// (hard) attempt now also increments — harmless, since the window reset
// restarts the count after `windowDays` of inactivity.
export async function enforceCustomerLimit(
  db: SupabaseClient,
  args: { user_id: string; tenant_id: string },
): Promise<CustomerLimitDecision> {
  const windowDays = Number(process.env.CUSTOMER_CHAT_WINDOW_DAYS ?? 30);
  const soft1Cooldown = Number(process.env.CUSTOMER_CHAT_SOFT1_COOLDOWN_DAYS ?? 7);
  const soft2Cooldown = Number(process.env.CUSTOMER_CHAT_SOFT2_COOLDOWN_DAYS ?? 3);

  const resolved = await resolveCaps(db, args.user_id, args.tenant_id);

  // Atomic consume-then-check. The RPC returns the post-increment count and
  // guarantees the row exists afterward.
  const { data: incremented, error: incErr } = await db.rpc("increment_customer_chat_count", {
    p_user_id: args.user_id,
    p_tenant_id: args.tenant_id,
    p_window_days: windowDays,
  });
  if (incErr) throw new Error(`increment_customer_chat_count failed: ${incErr.message}`);
  const nextCount = Number(incremented);
  if (!Number.isFinite(nextCount)) {
    throw new Error("increment_customer_chat_count returned a non-numeric count");
  }
  const now = new Date().toISOString();

  // Read the cooldown timestamps (row exists post-increment). Not
  // security-critical: a race here at worst issues a duplicate soft nudge.
  const { data: meta, error: metaErr } = await db
    .from("customer_chat_counters")
    .select("soft1_last_issued_at, soft2_last_issued_at")
    .eq("user_id", args.user_id)
    .eq("tenant_id", args.tenant_id)
    .maybeSingle();
  if (metaErr) throw new Error(`customer_chat_counters.read failed: ${metaErr.message}`);
  const cooldowns = (meta ?? {}) as {
    soft1_last_issued_at?: string | null;
    soft2_last_issued_at?: string | null;
  };

  // Persist the resolved-caps snapshot (diagnostic — what caps were applied).
  await safeAwait(db
    .from("customer_chat_counters")
    .update({
      resolved_soft1_cap: resolved.soft1_cap,
      resolved_soft2_cap: resolved.soft2_cap,
      resolved_hard_cap: resolved.hard_cap,
      resolved_booking_bonus_percent: resolved.booking_bonus_percent,
      resolved_at: now,
    })
    .eq("user_id", args.user_id)
    .eq("tenant_id", args.tenant_id), "customer_chat_counters.update.resolved");

  // Hard tier: the consumed count is over hard_cap → block (AI not called).
  if (nextCount > resolved.hard_cap) {
    const oldestSince = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    await safeAwait(db
      .from("customer_chat_counters")
      .update({ hard_limit_hit_at: now })
      .eq("user_id", args.user_id)
      .eq("tenant_id", args.tenant_id), "customer_chat_counters.update.hard");
    return { tier: "hard", resolved, current_count: nextCount, reset_at: oldestSince };
  }

  // Soft2 (between soft2_cap and hard_cap, cooldown 3d)
  if (nextCount >= resolved.soft2_cap) {
    if (!withinCooldown(cooldowns.soft2_last_issued_at ?? null, soft2Cooldown)) {
      const augmentation = String(
        await loadPlatformSetting(
          db,
          "customer_chat_soft2_persona_prompt",
          "Note: this customer has had extensive chat time. Gently but directly steer toward a specific booking decision.",
        ),
      );
      await safeAwait(db
        .from("customer_chat_counters")
        .update({ soft2_last_issued_at: now })
        .eq("user_id", args.user_id)
        .eq("tenant_id", args.tenant_id), "customer_chat_counters.update");
      await writeAuditLog({
        tenant_id: args.tenant_id,
        actor_user_id: args.user_id,
        actor_type: "system",
        action: "customer_chat.soft2_warning_issued",
        resource_type: "user",
        resource_id: args.user_id,
        changes: { current_count: nextCount },
      });
      return { tier: "soft2", resolved, current_count: nextCount, persona_augmentation: augmentation };
    }
  } else if (nextCount >= resolved.soft1_cap) {
    if (!withinCooldown(cooldowns.soft1_last_issued_at ?? null, soft1Cooldown)) {
      const augmentation = String(
        await loadPlatformSetting(
          db,
          "customer_chat_soft1_persona_prompt",
          "Note: this customer has been chatting actively. Gently encourage focusing on a specific cruise to book.",
        ),
      );
      await safeAwait(db
        .from("customer_chat_counters")
        .update({ soft1_last_issued_at: now })
        .eq("user_id", args.user_id)
        .eq("tenant_id", args.tenant_id), "customer_chat_counters.update");
      await writeAuditLog({
        tenant_id: args.tenant_id,
        actor_user_id: args.user_id,
        actor_type: "system",
        action: "customer_chat.soft1_nudge_issued",
        resource_type: "user",
        resource_id: args.user_id,
        changes: { current_count: nextCount },
      });
      return { tier: "soft1", resolved, current_count: nextCount, persona_augmentation: augmentation };
    }
  }

  return { tier: "below", resolved, current_count: nextCount };
}

function withinCooldown(lastAt: string | null, cooldownDays: number): boolean {
  if (!lastAt) return false;
  return new Date(lastAt).getTime() > Date.now() - cooldownDays * 24 * 60 * 60 * 1000;
}

// §24.9 Haiku-generated conversation summary when a customer hits the hard
// limit. The summary is the human-readable signal platform admin sees.
// Returns the summary JSON or null on failure (caller logs a stub then).
export async function generateHardLimitSummary(
  db: SupabaseClient,
  args: { user_id: string; tenant_id: string; user_email: string | null },
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const windowDays = Number(process.env.CUSTOMER_CHAT_WINDOW_DAYS ?? 30);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: msgs } = await db
    .from("messages")
    .select("role, content, created_at, conversations!inner(user_id, tenant_id)")
    .gte("created_at", since)
    .eq("conversations.user_id", args.user_id)
    .eq("conversations.tenant_id", args.tenant_id)
    .order("created_at", { ascending: true })
    .limit(200);

  const messages = (msgs ?? []) as Array<{ role: string; content: string; created_at: string }>;
  if (messages.length === 0) return null;

  const transcript = messages
    .map((m) => `[${m.role}] ${String(m.content).slice(0, 500)}`)
    .join("\n");

  const model = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";
  try {
    const { text } = await instrumentedClaudeCall({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      model,
      purpose: "other",
      max_tokens: 512,
      system: `Summarize the customer's chat activity over the past ${windowDays} days. Return JSON only:
{"topics_discussed":[...up to 6 short topics...],"booking_intent_signal":"low|medium|high"}.`,
      messages: [{ role: "user", content: transcript.slice(0, 12000) }],
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { topics_discussed?: string[]; booking_intent_signal?: string };

    return {
      alert_type: "customer_chat_hard_limit",
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      user_email: args.user_email,
      conversation_summary: {
        message_count_total: messages.length,
        first_message_at: messages[0]?.created_at,
        last_message_at: messages[messages.length - 1]?.created_at,
        topics_discussed: parsed.topics_discussed ?? [],
        booking_intent_signal: parsed.booking_intent_signal ?? "low",
      },
      summary_generated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
