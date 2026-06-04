// Issue #689 — Embedding-cost telemetry.
//
// Writes one rag_ai_call_log row per successful embedding call, both for
// the synchronous embed() path (when the batch flag is off) and the batch
// reconciler's per-row success path. tenant_id is NULLABLE — platform-admin
// ingests have no tenant to bill.
//
// The dashboard at /admin/resources unions main's ai_call_log with this
// table and the existing aggregation by model picks up the embedding rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

// Rates mirror the main app's AI_PRICING_DEFAULTS for the two embedding
// models. Kept duplicated rather than imported across apps because the rag
// service is its own deploy unit. If main's catalog gains a new embedding
// model, add it here too.
const EMBEDDING_RATES_CENTS_PER_MILLION: Record<string, number> = {
  "text-embedding-3-small": 200,
  "text-embedding-3-large": 1300,
};

export function estimateEmbeddingCostCents(model: string, input_tokens: number): number {
  const rate = EMBEDDING_RATES_CENTS_PER_MILLION[model];
  if (!rate) {
    console.warn(`[rag pricing] no rate for "${model}"; charging $0`);
    return 0;
  }
  return Math.floor((Math.max(0, input_tokens) * rate) / 1_000_000);
}

export interface LogEmbeddingCallArgs {
  db: SupabaseClient;
  tenant_id: string | null;
  model: string;
  source: "sync" | "batch";
  input_tokens: number;
  latency_ms?: number;
}

export async function logEmbeddingCall(args: LogEmbeddingCallArgs): Promise<void> {
  const cost_estimate_cents = estimateEmbeddingCostCents(args.model, args.input_tokens);
  await safeAwait(
    args.db.from("rag_ai_call_log").insert({
      tenant_id: args.tenant_id,
      model: args.model,
      vendor: "openai",
      purpose: "embedding",
      source: args.source,
      input_tokens: args.input_tokens,
      output_tokens: 0,
      cost_estimate_cents,
      latency_ms: args.latency_ms ?? null,
    }),
    "rag_ai_call_log.insert",
  );
}
