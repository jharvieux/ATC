// §27.12 — AI pricing catalog.
//
// Source of truth: the AI_PRICING_DEFAULTS constant below, override-able
// at runtime via platform_settings.ai_pricing_catalog JSONB. Operators
// update the override row via PUT /api/admin/ai-pricing (no deploy
// needed). The daily-refresh cron flips ai_pricing_stale when the last
// operator update is more than 30 days old so the admin dashboard can
// nudge re-verification.
//
// Cost units: integer cents per million tokens. BigInt math throughout to
// avoid floating-point drift on small per-call amounts.
//
// Sources (last confirmed 2026-05-23):
//   • Anthropic:  https://www.anthropic.com/pricing
//   • OpenAI:     https://openai.com/api/pricing/
//   • Values are illustrative — operator confirms before each deploy.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ModelPricing {
  input_per_million_cents: number;
  output_per_million_cents: number;
}

export const AI_PRICING_DEFAULTS: Record<string, ModelPricing> = {
  // TODO(#857): confirm claude-opus-4-8 list price; mirrors 4-7 for now so cost
  // tracking doesn't zero out (#851 adopt-opus-4.8).
  "claude-opus-4-8":           { input_per_million_cents: 150000, output_per_million_cents: 750000 },
  "claude-opus-4-7":           { input_per_million_cents: 150000, output_per_million_cents: 750000 },
  "claude-sonnet-4-6":         { input_per_million_cents:  30000, output_per_million_cents: 150000 },
  "claude-haiku-4-5-20251001": { input_per_million_cents:   8000, output_per_million_cents:  40000 },
  // #851 — undated "latest" alias resolves to the same Haiku 4.5 snapshot; keep
  // its pricing in lockstep with the pinned entry so cost-tracking never zeroes
  // out when the alias serves a call.
  "claude-haiku-4-5":          { input_per_million_cents:   8000, output_per_million_cents:  40000 },
  "text-embedding-3-small":    { input_per_million_cents:    200, output_per_million_cents:      0 },
  "text-embedding-3-large":    { input_per_million_cents:   1300, output_per_million_cents:      0 },
  "gpt-4o-mini":               { input_per_million_cents:  15000, output_per_million_cents:  60000 },
};

const ONE_MILLION = 1_000_000n;

let _override: Record<string, ModelPricing> | null = null;
let _overrideLoadedAt = 0;

/**
 * Reads platform_settings.ai_pricing_catalog if present and caches it for
 * one minute. Refresh is automatic; operator updates the row from the
 * admin UI and the next call picks it up.
 */
async function loadOverride(db: SupabaseClient): Promise<Record<string, ModelPricing>> {
  const now = Date.now();
  if (_override && now - _overrideLoadedAt < 60_000) return _override;
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "ai_pricing_catalog")
    .maybeSingle();
  _override = ((data as { value?: unknown } | null)?.value as Record<string, ModelPricing> | undefined) ?? {};
  _overrideLoadedAt = now;
  return _override;
}

/**
 * Synchronous variant for the wrapper hot path. Reads from process-level
 * cache only — if no override has been loaded yet, returns defaults.
 * The async loadOverride() refreshes the cache periodically.
 */
export function getCostEstimate(args: {
  model: string;
  input_tokens: number;
  output_tokens: number;
}): bigint {
  const overrides = _override ?? {};
  const pricing = overrides[args.model] ?? AI_PRICING_DEFAULTS[args.model];
  if (!pricing) {
    // Unknown model — charge $0 rather than fail the call. Log so it's
    // discoverable.
    console.warn(`[pricing] no entry for model "${args.model}"; charging $0`);
    return 0n;
  }
  const input = BigInt(Math.max(0, args.input_tokens)) * BigInt(pricing.input_per_million_cents);
  const output = BigInt(Math.max(0, args.output_tokens)) * BigInt(pricing.output_per_million_cents);
  // Divide by 1M LAST to keep precision.
  return (input + output) / ONE_MILLION;
}

/** Caller (the wrapper) primes the cache. */
export async function primePricingCache(db: SupabaseClient): Promise<void> {
  await loadOverride(db);
}

/** Test-only reset. */
export function _resetPricingCacheForTests(): void {
  _override = null;
  _overrideLoadedAt = 0;
}
