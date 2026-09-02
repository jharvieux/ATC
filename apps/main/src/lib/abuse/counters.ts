// §27.7 — Real-time counter increments at every relevant event.
//
// Centralized so call sites at the chat handler / email send / group
// invite / RAG submission stay tight (single function call). Database RPCs
// consume each delta atomically and return the authoritative value used by
// the state-machine check.
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

export interface CounterContext {
  db: SupabaseClient;
  tenant: TenantRevenueSnapshot & { tenant_id: string };
}

export async function incrementChatMessages(ctx: CounterContext): Promise<void> {
  await incrementMonthlyCounter(ctx, "chat_volume", 1);
  await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "chat_volume" });
}

export async function incrementEmailSent(ctx: CounterContext): Promise<void> {
  await incrementMonthlyCounter(ctx, "email_volume", 1);
  await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "email_volume" });
}

export async function incrementGroupInvitees(ctx: CounterContext, count: number): Promise<void> {
  if (count <= 0) return;
  await incrementMonthlyCounter(ctx, "group_invite", count);
  await checkStateTransitionIfNeeded({ db: ctx.db, tenant: ctx.tenant, dimension: "group_invite" });
}

async function incrementMonthlyCounter(
  ctx: CounterContext,
  dimension: "chat_volume" | "email_volume" | "group_invite",
  amount: number,
): Promise<void> {
  await safeAwait(
    ctx.db.rpc("increment_tenant_usage_counter", {
      p_tenant_id: ctx.tenant.tenant_id,
      p_billing_period: currentBillingPeriodRange(),
      p_dimension: dimension,
      p_amount: amount,
    }),
    "tenant_usage_metrics.rpc.increment",
  );
}

/**
 * Bump current_tenant_chunks_count by delta (+/-) and run the rag_cap
 * state transition. The caller's promoted count initializes a missing row;
 * an existing row's locked value remains authoritative.
 */
export async function adjustRagChunkCount(
  ctx: CounterContext,
  delta: number,
  promoted_chunks_count: number,
): Promise<void> {
  const rows = await safeAwait(
    ctx.db.rpc("adjust_tenant_rag_usage", {
      p_tenant_id: ctx.tenant.tenant_id,
      p_delta: delta,
      p_promoted_chunks_count: promoted_chunks_count,
    }),
    "tenant_rag_quotas.rpc.adjust",
  ) as Array<{
    current_tenant_chunks_count: number;
    promoted_chunks_count: number;
  }> | null;
  const quota = rows?.[0];
  if (!quota) throw new Error("adjust_tenant_rag_usage returned no row");
  await checkStateTransitionIfNeeded({
    db: ctx.db,
    tenant: ctx.tenant,
    dimension: "rag_cap",
    promoted_chunks_count: quota.promoted_chunks_count,
  });
}
