// §27.7 — Real-time counter increments at every relevant event.
//
// Centralized so call sites at the chat handler / email send / group
// invite / RAG submission stay tight (single function call). Each helper
// also fires the state-machine check after the increment.
//
// AI cost is NOT here — the call wrapper increments + checks ai_cost
// directly. These helpers cover the four count dimensions + RAG.

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkStateTransitionIfNeeded } from "./state-machine";
import type { TenantRevenueSnapshot } from "./revenue";
import { safeAwait } from "@/lib/db/safe-mutation";

function currentBillingPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

async function upsertMetrics(
  db: SupabaseClient,
  tenant_id: string,
  patch: Record<string, unknown>,
  increments: Record<string, number>,
): Promise<void> {
  const period = currentBillingPeriodRange();
  const { data: existing } = await db
    .from("tenant_usage_metrics")
    .select("id, chat_messages_count, email_sent_count, email_sent_today, email_sent_day_ref, group_invitees_count")
    .eq("tenant_id", tenant_id)
    .eq("billing_period", period)
    .maybeSingle();

  if (existing) {
    const row = existing as Record<string, unknown>;
    const update: Record<string, unknown> = { ...patch };
    for (const [col, delta] of Object.entries(increments)) {
      const current = Number(row[col] ?? 0);
      update[col] = current + delta;
    }
    await safeAwait(db.from("tenant_usage_metrics").update(update).eq("id", row.id as string).eq("tenant_id", tenant_id), "tenant_usage_metrics.update");
  } else {
    await safeAwait(db.from("tenant_usage_metrics").insert({
      tenant_id,
      billing_period: period,
      ...patch,
      ...increments,
    }), "tenant_usage_metrics.insert");
  }
}

export interface CounterContext {
  db: SupabaseClient;
  tenant: TenantRevenueSnapshot & { tenant_id: string };
}

export async function incrementChatMessages(ctx: CounterContext): Promise<void> {
  await upsertMetrics(ctx.db, ctx.tenant.tenant_id, {}, { chat_messages_count: 1 });
  // Read current count after increment for the state-machine check.
  const { data } = await ctx.db
    .from("tenant_usage_metrics")
    .select("chat_messages_count")
    .eq("tenant_id", ctx.tenant.tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const count = Number((data as { chat_messages_count?: number } | null)?.chat_messages_count ?? 0);
  await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "chat_volume", metric_value: BigInt(count) });
}

export async function incrementEmailSent(ctx: CounterContext): Promise<void> {
  // Day-anchor reset: if email_sent_day_ref < today, reset email_sent_today.
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await ctx.db
    .from("tenant_usage_metrics")
    .select("id, email_sent_today, email_sent_day_ref, email_sent_count")
    .eq("tenant_id", ctx.tenant.tenant_id)
    .eq("billing_period", currentBillingPeriodRange())
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; email_sent_today: number; email_sent_day_ref: string; email_sent_count: number };
    const dayChanged = row.email_sent_day_ref !== today;
    const newToday = dayChanged ? 1 : (row.email_sent_today ?? 0) + 1;
    const newCount = (row.email_sent_count ?? 0) + 1;
    await safeAwait(ctx.db
      .from("tenant_usage_metrics")
      .update({
        email_sent_count: newCount,
        email_sent_today: newToday,
        email_sent_day_ref: today,
      })
      .eq("id", row.id)
      .eq("tenant_id", ctx.tenant.tenant_id), "tenant_usage_metrics.update");
    await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "email_volume", metric_value: BigInt(newToday) });
  } else {
    await safeAwait(ctx.db.from("tenant_usage_metrics").insert({
      tenant_id: ctx.tenant.tenant_id,
      billing_period: currentBillingPeriodRange(),
      email_sent_count: 1,
      email_sent_today: 1,
      email_sent_day_ref: today,
    }), "tenant_usage_metrics.insert");
  }
}

export async function incrementGroupInvitees(ctx: CounterContext, count: number): Promise<void> {
  if (count <= 0) return;
  await upsertMetrics(ctx.db, ctx.tenant.tenant_id, {}, { group_invitees_count: count });
  const { data } = await ctx.db
    .from("tenant_usage_metrics")
    .select("group_invitees_count")
    .eq("tenant_id", ctx.tenant.tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const total = Number((data as { group_invitees_count?: number } | null)?.group_invitees_count ?? 0);
  await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "group_invite", metric_value: BigInt(total) });
}

/**
 * Bump current_tenant_chunks_count by delta (+/-) and run the rag_cap
 * state transition. Caller supplies the promoted_chunks_count for the
 * threshold calculation.
 */
export async function adjustRagChunkCount(
  ctx: CounterContext,
  delta: number,
  promoted_chunks_count: number,
): Promise<void> {
  const { data: row } = await ctx.db
    .from("tenant_rag_quotas")
    .select("current_tenant_chunks_count, base_cap")
    .eq("tenant_id", ctx.tenant.tenant_id)
    .maybeSingle();

  if (!row) {
    // Initialize the quota row on first chunk.
    await safeAwait(ctx.db.from("tenant_rag_quotas").insert({
      tenant_id: ctx.tenant.tenant_id,
      base_cap: 0, // populated by resolveThresholds on read; default 0 here
      current_tenant_chunks_count: Math.max(0, delta),
      promoted_chunks_count,
    }), "tenant_rag_quotas.insert");
  } else {
    const existing = row as { current_tenant_chunks_count: number };
    const next = Math.max(0, existing.current_tenant_chunks_count + delta);
    await safeAwait(ctx.db
      .from("tenant_rag_quotas")
      .update({ current_tenant_chunks_count: next, promoted_chunks_count })
      .eq("tenant_id", ctx.tenant.tenant_id), "tenant_rag_quotas.update");
  }

  const { data: after } = await ctx.db
    .from("tenant_rag_quotas")
    .select("current_tenant_chunks_count")
    .eq("tenant_id", ctx.tenant.tenant_id)
    .maybeSingle();
  const count = Number((after as { current_tenant_chunks_count?: number } | null)?.current_tenant_chunks_count ?? 0);
  await checkStateTransitionIfNeeded({
    db: ctx.db,
    tenant: ctx.tenant,
    dimension: "rag_cap",
    metric_value: count,
    promoted_chunks_count,
  });
}
