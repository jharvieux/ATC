// #851 — central model config + the "attempt latest, fall back on issues" policy.
//
// Single source of truth for Anthropic model ids and the ordered fallback chain
// per tier. "Latest" = Anthropic's undated alias (auto-rolls forward to the
// current snapshot within a generation); the pinned dated snapshot is the
// in-tier fallback. Verified 2026-06-07 against the live API (root key): the
// alias `claude-haiku-4-5` and all pinned/undated ids below return 200.
//
// Callers still pass a model id to instrumentedClaudeCall; that id selects the
// TIER, and the wrapper tries the tier's chain latest-first. A retiring snapshot
// is caught by the canary (#851 PR3) with months of runway; this chain + the
// circuit-breaker are the runtime safety net for the gap.

export const HAIKU_LATEST = "claude-haiku-4-5"; // undated alias → newest Haiku 4.5 snapshot
export const HAIKU_PINNED = "claude-haiku-4-5-20251001"; // pinned fallback
export const SONNET = "claude-sonnet-4-6"; // undated (latest within 4.6)
export const OPUS = "claude-opus-4-7"; // undated (latest within 4.7)

type Tier = "haiku" | "sonnet" | "opus";

// Ordered chains: try left → right, first success wins.
const TIER_CHAINS: Record<Tier, string[]> = {
  haiku: [HAIKU_LATEST, HAIKU_PINNED],
  sonnet: [SONNET],
  opus: [OPUS],
};

// Any model id a caller might pass → its tier.
const MODEL_TIER: Record<string, Tier> = {
  [HAIKU_LATEST]: "haiku",
  [HAIKU_PINNED]: "haiku",
  [SONNET]: "sonnet",
  [OPUS]: "opus",
};

// The attempt-latest chain for a desired model. Unknown ids → [desiredModel]
// (an explicit/new id still works, just without an in-tier fallback).
export function resolveModelChain(desiredModel: string): string[] {
  const tier = MODEL_TIER[desiredModel];
  return tier ? [...TIER_CHAINS[tier]] : [desiredModel];
}

// ── Circuit-breaker: once a model errors, skip it for a cooldown so we don't
// hammer a broken/retired model every request — but keep re-probing so we
// return to it automatically once it's healthy ("sticky but self-healing").
// Module-level (per serverless instance) is sufficient: it's a hot-path hint,
// not a correctness gate. Never skip the LAST entry in a chain (so stale breaker
// state can't fail a call outright).
const COOLDOWN_MS = 60_000;
const breaker = new Map<string, number>(); // model → cooldown-until epoch ms

export function _resetModelBreakerForTests(): void {
  breaker.clear();
}

export interface AttemptModelChainOpts {
  now?: () => number;
  onFallback?: (preferred: string, used: string) => void;
  onError?: (model: string, err: unknown) => void;
}

// Try each model in `chain` (latest first); on error, trip the breaker and try
// the next; return the first success + which model served it. Throws the last
// error only if every entry fails.
export async function attemptModelChain<T>(
  chain: string[],
  attempt: (model: string) => Promise<T>,
  opts: AttemptModelChainOpts = {},
): Promise<{ result: T; model: string }> {
  const now = opts.now ?? Date.now;
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    const isLast = i === chain.length - 1;
    const cooledUntil = breaker.get(model);
    if (!isLast && cooledUntil !== undefined && cooledUntil > now()) continue; // skip recently-failed
    try {
      const result = await attempt(model);
      breaker.delete(model);
      if (model !== chain[0]) opts.onFallback?.(chain[0]!, model);
      return { result, model };
    } catch (err) {
      lastErr = err;
      breaker.set(model, now() + COOLDOWN_MS);
      opts.onError?.(model, err);
    }
  }
  throw lastErr ?? new Error("attemptModelChain: empty chain");
}
