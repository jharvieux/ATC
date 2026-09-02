// §27.7 — Abuse state machine.
//
// State classification runs inside row-locking database functions. Each state
// advancement and its usage_limit_events outbox marker commit together; the
// marker is dispatched with a deterministic Inngest id and remains recoverable
// until dispatch succeeds.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveThresholds, type AbuseDimension } from "./thresholds";
import type { TenantRevenueSnapshot, TenantTierCode } from "./revenue";

export type AbuseState = "ok" | "soft1" | "soft2" | "hard";
export type RagState = "ok" | "approaching" | "at_cap" | "over_cap";

export interface TransitionOutboxRow {
  event_id: string;
  event_tenant_id: string;
  event_dimension: string;
  event_from_state: string;
  event_to_state: string;
  event_metric_value: string | number;
  event_threshold_crossed: string | number;
  event_created: boolean;
}

export interface CheckTransitionInput {
  db: SupabaseClient;
  tenant: TenantRevenueSnapshot & { tenant_id: string };
  dimension: AbuseDimension;
  /** Compatibility hint only; the RPC reads the authoritative locked value. */
  metric_value: bigint | number;
  /** Required for resolving the rag_cap threshold. */
  promoted_chunks_count?: number;
  /** Subscription changes may move a monthly state down as well as up. */
  allow_downgrade?: boolean;
  reason?: string;
  /** Recovery may finish an evaluation queued just before month rollover. */
  billing_period?: string;
}

type RecoverableDimension = Exclude<AbuseDimension, "help_submission_rate">;

const TENANT_TIER_CODES = new Set<TenantTierCode>([
  "byo_research",
  "byo_professional",
  "byo_agency",
  "sub_starter",
  "sub_pro",
  "sub_agency",
]);

function currentBillingPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
  return `[${start},${end})`;
}

function firstTransitionRow(data: unknown): TransitionOutboxRow | null {
  if (Array.isArray(data)) return (data[0] as TransitionOutboxRow | undefined) ?? null;
  return (data as TransitionOutboxRow | null) ?? null;
}

export async function dispatchTransitionOutbox(
  db: SupabaseClient,
  row: TransitionOutboxRow,
): Promise<void> {
  await inngest.send({
    id: `abuse-state-transition:${row.event_id}`,
    name: "abuse.state_transition",
    data: {
      usage_event_id: row.event_id,
      tenant_id: row.event_tenant_id,
      dimension: row.event_dimension,
      from_state: row.event_from_state,
      to_state: row.event_to_state,
      metric_value: String(row.event_metric_value),
      threshold_crossed: String(row.event_threshold_crossed),
    },
  });

  await safeAwait(
    db
      .from("usage_limit_events")
      .update({
        event_dispatch_pending: false,
        event_dispatched_at: new Date().toISOString(),
      })
      .eq("id", row.event_id)
      .eq("tenant_id", row.event_tenant_id)
      .eq("dimension", row.event_dimension)
      .eq("event_dispatch_pending", true),
    "usage_limit_events.update.dispatch_complete",
  );
}

export async function dispatchPendingTransitionOutbox(
  db: SupabaseClient,
  limit = 100,
): Promise<number> {
  const rows = await safeAwait(
    db
      // d091-allow:service-role-tenant — bounded platform outbox recovery must scan pending transitions across tenants; dispatch completion is tenant-scoped.
      .from("usage_limit_events")
      .select("id, tenant_id, dimension, from_state, to_state, metric_value, threshold_crossed")
      .eq("event_dispatch_pending", true)
      .order("triggered_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit),
    "usage_limit_events.select.dispatch_pending",
  );
  const pending = (rows ?? []) as Array<{
    id: string;
    tenant_id: string;
    dimension: string;
    from_state: string;
    to_state: string;
    metric_value: string | number;
    threshold_crossed: string | number;
  }>;

  await Promise.all(
    pending.map((row) =>
      dispatchTransitionOutbox(db, {
        event_id: row.id,
        event_tenant_id: row.tenant_id,
        event_dimension: row.dimension,
        event_from_state: row.from_state,
        event_to_state: row.to_state,
        event_metric_value: row.metric_value,
        event_threshold_crossed: row.threshold_crossed,
        event_created: false,
      }),
    ),
  );
  return pending.length;
}

export async function recoverPendingStateEvaluations(
  db: SupabaseClient,
  limit = 100,
): Promise<number> {
  const evaluations = (await safeAwait(
    db
      // d091-allow:service-role-tenant — bounded platform recovery scans durable evaluation markers across tenants; each state RPC is tenant-scoped.
      .from("usage_limit_state_evaluations")
      .select("tenant_id, dimension, billing_period")
      .order("requested_at", { ascending: true })
      .order("tenant_id", { ascending: true })
      .limit(limit),
    "usage_limit_state_evaluations.select.pending",
  ) ?? []) as Array<{
    tenant_id: string;
    dimension: RecoverableDimension;
    billing_period: string | null;
  }>;
  if (evaluations.length === 0) return 0;

  const tenantIds = [...new Set(evaluations.map((row) => row.tenant_id))];
  const tenantRows = (await safeAwait(
    db
      // d091-allow:service-role-tenant — ids come only from the bounded durable recovery queue above.
      .from("tenants")
      .select("id, tier_id, seat_count, billing_period")
      .in("id", tenantIds)
      .limit(limit),
    "tenants.select.usage_state_recovery",
  ) ?? []) as Array<{
    id: string;
    tier_id: string | null;
    seat_count: number | null;
    billing_period: "monthly" | "annual" | null;
  }>;
  const tierIds = [...new Set(tenantRows.map((row) => row.tier_id).filter((id): id is string => !!id))];
  const tierRows = tierIds.length === 0
    ? []
    : (await safeAwait(
        db
          // d091-allow:service-role-tenant — tier ids are referenced by the bounded tenant recovery set above.
          .from("tier_definitions")
          .select("id, code")
          .in("id", tierIds)
          .limit(tierIds.length),
        "tier_definitions.select.usage_state_recovery",
      ) ?? []) as Array<{ id: string; code: string }>;
  const tierCodeById = new Map(tierRows.map((row) => [row.id, row.code]));

  const ragTenantIds = evaluations
    .filter((row) => row.dimension === "rag_cap")
    .map((row) => row.tenant_id);
  const ragRows = ragTenantIds.length === 0
    ? []
    : (await safeAwait(
        db
          // d091-allow:service-role-tenant — tenant ids come only from bounded RAG recovery markers.
          .from("tenant_rag_quotas")
          .select("tenant_id, promoted_chunks_count")
          .in("tenant_id", ragTenantIds)
          .limit(ragTenantIds.length),
        "tenant_rag_quotas.select.usage_state_recovery",
      ) ?? []) as Array<{ tenant_id: string; promoted_chunks_count: number }>;
  const promotedByTenant = new Map(ragRows.map((row) => [row.tenant_id, row.promoted_chunks_count]));
  const tenantById = new Map(tenantRows.map((row) => [row.id, row]));

  await Promise.all(evaluations.map(async (evaluation) => {
    const tenantRow = tenantById.get(evaluation.tenant_id);
    if (!tenantRow) return;
    const tierCode = tenantRow.tier_id
      ? tierCodeById.get(tenantRow.tier_id)
      : "byo_research";
    if (!tierCode || !TENANT_TIER_CODES.has(tierCode as TenantTierCode)) {
      throw new Error(`Unknown tier for usage-state recovery tenant ${evaluation.tenant_id}`);
    }
    await checkStateTransitionIfNeeded({
      db,
      tenant: {
        tenant_id: tenantRow.id,
        tier_code: tierCode as TenantTierCode,
        seat_count: tenantRow.seat_count ?? 1,
        billing_period: tenantRow.billing_period ?? "monthly",
      },
      dimension: evaluation.dimension,
      metric_value: 0,
      promoted_chunks_count: promotedByTenant.get(evaluation.tenant_id) ?? 0,
      ...(evaluation.billing_period ? { billing_period: evaluation.billing_period } : {}),
    });
  }));
  return evaluations.length;
}

/**
 * Re-evaluates the authoritative counter under a database row lock. The input
 * metric is intentionally not trusted because callers may race or may only know
 * the most recent delta (AI cost). Returns true only when this call created a
 * new logical transition; pending outbox work is retried either way.
 */
export async function checkStateTransitionIfNeeded(
  input: CheckTransitionInput,
): Promise<boolean> {
  const { db, tenant, dimension } = input;
  const thresholds = await resolveThresholds(db, tenant, input.promoted_chunks_count ?? 0);

  if (dimension === "help_submission_rate") {
    throw new Error(
      "checkStateTransitionIfNeeded: 'help_submission_rate' is handled by " +
        "lib/abuse/help-submission-rate.ts (per-day semantics; not per-billing-period).",
    );
  }

  let result: unknown;
  if (dimension === "rag_cap") {
    result = await safeAwait(
      db.rpc("advance_tenant_rag_state", {
        p_tenant_id: tenant.tenant_id,
        p_approaching: thresholds.rag_cap_total.approaching,
        p_effective: thresholds.rag_cap_total.effective,
        p_reason: input.reason ?? null,
      }),
      "tenant_rag_quotas.rpc.advance_state",
    );
  } else {
    const monthlyThresholds = (() => {
      switch (dimension) {
        case "ai_cost":
          return thresholds.ai_cost_cents;
        case "chat_volume":
          return thresholds.chat_volume_messages_monthly;
        case "email_volume":
          return thresholds.email_volume_daily;
        case "group_invite":
          return thresholds.group_invite_monthly;
      }
    })();
    result = await safeAwait(
      db.rpc("advance_tenant_usage_state", {
        p_tenant_id: tenant.tenant_id,
        p_billing_period: input.billing_period ?? currentBillingPeriodRange(),
        p_dimension: dimension,
        p_soft1: String(monthlyThresholds.soft1),
        p_soft2: String(monthlyThresholds.soft2),
        p_hard: String(monthlyThresholds.hard),
        p_allow_downgrade: input.allow_downgrade ?? false,
        p_reason: input.reason ?? null,
      }),
      "tenant_usage_metrics.rpc.advance_state",
    );
  }

  const row = firstTransitionRow(result);
  if (row) await dispatchTransitionOutbox(db, row);
  return row?.event_created ?? false;
}
