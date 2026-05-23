// §27.12 — The ONLY file allowed to import Anthropic / OpenAI directly.
//
// Every other call site routes through this wrapper. The wrapper:
//   1. Optionally downgrades the model per §27.6 AI-cost soft1 enforcement
//      (non-customer-facing purposes only).
//   2. Calls the vendor.
//   3. Records vendor-health success/failure (§26.9 BP26 wiring).
//   4. Writes an ai_call_log row with attribution per §27.12.
//   5. UPSERTs tenant_usage_metrics.ai_cost_cents for the current period.
//   6. Calls checkStateTransitionIfNeeded after the increment.
//
// The lint rule atc/no-direct-anthropic-or-openai-import allows ONLY this
// file (tightened from src/lib/ai/** in BP26 to this single path).

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { getCostEstimate, primePricingCache } from "./pricing";
import {
  recordVendorFailure,
  recordVendorSuccess,
} from "@/lib/vendor-health/registry";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";
import type { TenantRevenueSnapshot } from "@/lib/abuse/revenue";

export type AICallPurpose =
  | "chat_main"
  | "chat_supervisor"
  | "entity_extraction"
  | "memory_extraction"
  | "rag_normalization"
  | "rag_pii_redaction"
  | "rag_relevance_scoring"
  | "persona_addendum_screen"
  | "forum_moderation"
  | "precruise_generation"
  | "quote_narrative"
  | "embedding"
  | "content_normalization"
  | "other";

// Purposes that run customer-facing turns. NOT downgraded at soft1.
const CUSTOMER_FACING_PURPOSES: ReadonlySet<AICallPurpose> = new Set([
  "chat_main",
  "precruise_generation",
  "quote_narrative",
]);

// PLATFORM_TENANT_ID — used for calls whose tenant attribution is genuinely
// platform-wide (cross-tenant cron embeddings, etc.). Document in MEMORY.
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000000";

// ─────────────────────────────────────────────────────────────────────
// selectModelForPurpose — §27.6 AI cost enforcement, soft1+
// ─────────────────────────────────────────────────────────────────────

const DOWNGRADE_MAP: Record<string, string> = {
  "claude-opus-4-7":   "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6": "claude-haiku-4-5-20251001",
};

export interface ModelSelectionInput {
  desired_model: string;
  purpose: AICallPurpose;
  ai_cost_state: "ok" | "soft1" | "soft2" | "hard";
}

export function selectModelForPurpose(input: ModelSelectionInput): string {
  if (input.ai_cost_state === "ok") return input.desired_model;
  if (input.ai_cost_state === "hard") return input.desired_model; // hard is enforced at the call site by NOT calling at all
  // soft1 + soft2: downgrade non-customer-facing purposes.
  if (CUSTOMER_FACING_PURPOSES.has(input.purpose)) return input.desired_model;
  return DOWNGRADE_MAP[input.desired_model] ?? input.desired_model;
}

// ─────────────────────────────────────────────────────────────────────
// Tenant snapshot loading
// ─────────────────────────────────────────────────────────────────────

interface CachedTenantSnapshot {
  tenant: TenantRevenueSnapshot & { tenant_id: string };
  ai_cost_state: "ok" | "soft1" | "soft2" | "hard";
  fetched_at: number;
}
const TENANT_SNAPSHOT_TTL_MS = 30_000;
const tenantSnapshotCache = new Map<string, CachedTenantSnapshot>();

async function loadTenantSnapshot(
  db: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
): Promise<CachedTenantSnapshot> {
  const cached = tenantSnapshotCache.get(tenant_id);
  if (cached && Date.now() - cached.fetched_at < TENANT_SNAPSHOT_TTL_MS) return cached;

  // Platform-tenant short-circuit — no row in tenants, treat as healthy.
  if (tenant_id === PLATFORM_TENANT_ID) {
    const fresh: CachedTenantSnapshot = {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      fetched_at: Date.now(),
    };
    tenantSnapshotCache.set(tenant_id, fresh);
    return fresh;
  }

  const { data: tenantRow } = await db
    .from("tenants")
    .select("id, tier_id, seat_count, billing_period")
    .eq("id", tenant_id)
    .maybeSingle();
  if (!tenantRow) {
    // Unknown tenant — fall back to safe defaults. The call still runs;
    // attribution will be wrong but we don't want to block.
    return {
      tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
      ai_cost_state: "ok",
      fetched_at: Date.now(),
    };
  }
  const tr = tenantRow as { tier_id: string; seat_count: number; billing_period: "monthly" | "annual" };

  let tier_code: TenantRevenueSnapshot["tier_code"] = "byo_research";
  if (tr.tier_id) {
    const { data: tierRow } = await db
      .from("tier_definitions")
      .select("code")
      .eq("id", tr.tier_id)
      .maybeSingle();
    const code = (tierRow as { code?: string } | null)?.code;
    if (code && [
      "byo_research", "byo_professional", "byo_agency",
      "sub_starter", "sub_pro", "sub_agency",
    ].includes(code)) {
      tier_code = code as TenantRevenueSnapshot["tier_code"];
    }
  }

  const { data: metricsRow } = await db
    .from("tenant_usage_metrics")
    .select("ai_cost_limit_state")
    .eq("tenant_id", tenant_id)
    .order("billing_period", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ai_cost_state = ((metricsRow as { ai_cost_limit_state?: string } | null)?.ai_cost_limit_state ?? "ok") as
    "ok" | "soft1" | "soft2" | "hard";

  const fresh: CachedTenantSnapshot = {
    tenant: { tenant_id, tier_code, seat_count: tr.seat_count ?? 1, billing_period: tr.billing_period ?? "monthly" },
    ai_cost_state,
    fetched_at: Date.now(),
  };
  tenantSnapshotCache.set(tenant_id, fresh);
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────
// Logging + counter increment
// ─────────────────────────────────────────────────────────────────────

function currentBillingPeriodRange(): string {
  // DATERANGE literal — `[start,end)` calendar month.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

async function logAndIncrement(args: {
  db: ReturnType<typeof createServiceRoleClient>;
  tenant_id: string;
  conversation_id?: string | null;
  user_id?: string | null;
  model: string;
  vendor: "anthropic" | "openai";
  purpose: AICallPurpose;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_cents: bigint;
}): Promise<void> {
  // 1. ai_call_log row.
  await args.db.from("ai_call_log").insert({
    tenant_id: args.tenant_id,
    conversation_id: args.conversation_id ?? null,
    user_id: args.user_id ?? null,
    model: args.model,
    vendor: args.vendor,
    purpose: args.purpose,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
    cost_estimate_cents: args.cost_cents.toString(),
    latency_ms: args.latency_ms,
  });

  // 2. tenant_usage_metrics UPSERT. PostgREST upsert needs explicit
  // onConflict; read-then-write keeps it simple here.
  if (args.tenant_id === PLATFORM_TENANT_ID) return; // skip metrics for platform overhead

  const period = currentBillingPeriodRange();
  const { data: existing } = await args.db
    .from("tenant_usage_metrics")
    .select("id, ai_cost_cents")
    .eq("tenant_id", args.tenant_id)
    .eq("billing_period", period)
    .maybeSingle();

  if (existing) {
    const current = BigInt((existing as { ai_cost_cents: string | number }).ai_cost_cents);
    const updated = current + args.cost_cents;
    await args.db
      .from("tenant_usage_metrics")
      .update({ ai_cost_cents: updated.toString() })
      .eq("id", (existing as { id: string }).id);
  } else {
    await args.db.from("tenant_usage_metrics").insert({
      tenant_id: args.tenant_id,
      billing_period: period,
      ai_cost_cents: args.cost_cents.toString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// instrumentedClaudeCall
// ─────────────────────────────────────────────────────────────────────

export interface InstrumentedClaudeArgs {
  tenant_id: string;
  conversation_id?: string | null;
  user_id?: string | null;
  model: string;
  purpose: AICallPurpose;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export async function instrumentedClaudeCall(
  args: InstrumentedClaudeArgs,
): Promise<{ text: string; raw: Anthropic.Messages.Message }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("instrumentedClaudeCall: ANTHROPIC_API_KEY not set");

  const db = createServiceRoleClient();
  await primePricingCache(db);
  const snapshot = await loadTenantSnapshot(db, args.tenant_id);
  const model = selectModelForPurpose({
    desired_model: args.model,
    purpose: args.purpose,
    ai_cost_state: snapshot.ai_cost_state,
  });

  const anthropic = new Anthropic({ apiKey });
  const start = Date.now();
  let resp: Anthropic.Messages.Message;
  try {
    resp = await anthropic.messages.create({
      model,
      max_tokens: args.max_tokens,
      ...(args.system ? { system: args.system } : {}),
      messages: args.messages,
    });
    recordVendorSuccess("anthropic");
  } catch (err) {
    recordVendorFailure("anthropic", err instanceof Error ? err.message : String(err));
    throw err;
  }

  const latency_ms = Date.now() - start;
  const input_tokens = resp.usage?.input_tokens ?? 0;
  const output_tokens = resp.usage?.output_tokens ?? 0;
  const cost = getCostEstimate({ model, input_tokens, output_tokens });

  await logAndIncrement({
    db,
    tenant_id: args.tenant_id,
    conversation_id: args.conversation_id ?? null,
    user_id: args.user_id ?? null,
    model,
    vendor: "anthropic",
    purpose: args.purpose,
    input_tokens,
    output_tokens,
    latency_ms,
    cost_cents: cost,
  });

  // Fire-and-forget state-transition check. Don't await — the call
  // result already exists and we don't want to block on the state read.
  void checkStateTransitionIfNeeded({
    db,
    tenant: snapshot.tenant,
    dimension: "ai_cost",
    metric_value: cost,
  }).catch((err) => console.warn("[call-wrapper] state-transition check failed:", err));

  const text = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  return { text, raw: resp };
}

// ─────────────────────────────────────────────────────────────────────
// instrumentedOpenAICall — embeddings only for now
// ─────────────────────────────────────────────────────────────────────

export interface InstrumentedOpenAIEmbeddingArgs {
  tenant_id: string;
  model: "text-embedding-3-small" | "text-embedding-3-large";
  input: string | string[];
  purpose: AICallPurpose;
}

export async function instrumentedOpenAIEmbedding(
  args: InstrumentedOpenAIEmbeddingArgs,
): Promise<{ embeddings: number[][]; raw: OpenAI.Embeddings.CreateEmbeddingResponse }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("instrumentedOpenAIEmbedding: OPENAI_API_KEY not set");

  const db = createServiceRoleClient();
  await primePricingCache(db);

  const openai = new OpenAI({ apiKey });
  const start = Date.now();
  let resp: OpenAI.Embeddings.CreateEmbeddingResponse;
  try {
    resp = await openai.embeddings.create({ model: args.model, input: args.input });
    recordVendorSuccess("openai");
  } catch (err) {
    recordVendorFailure("openai", err instanceof Error ? err.message : String(err));
    throw err;
  }
  const latency_ms = Date.now() - start;
  const input_tokens = resp.usage?.prompt_tokens ?? 0;
  const cost = getCostEstimate({ model: args.model, input_tokens, output_tokens: 0 });

  await logAndIncrement({
    db,
    tenant_id: args.tenant_id,
    model: args.model,
    vendor: "openai",
    purpose: args.purpose,
    input_tokens,
    output_tokens: 0,
    latency_ms,
    cost_cents: cost,
  });

  return { embeddings: resp.data.map((d) => d.embedding), raw: resp };
}

// Test-only — clears the tenant snapshot cache so tests can vary state.
export function _resetTenantSnapshotCacheForTests(): void {
  tenantSnapshotCache.clear();
}
