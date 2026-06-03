/**
 * BP32 §32.10.1 — Bug-intent recognizer for the customer travel concierge.
 *
 * Deterministic phrase-match pre-check that runs on every customer message
 * BEFORE the travel-concierge LLM call. On a match, the chat handler
 * surfaces the §32.10.1 offer ("It sounds like something might not be
 * working right…") with a structured action button. The customer can:
 *   1. Accept → enter the §32.10 customer bug flow (OAuth gate first).
 *   2. Decline → travel concierge continues normally; no further offer
 *      this session unless the customer re-triggers.
 *
 * Gated by:
 *   - PHASE_2_CUSTOMER_BUG_FLOW_ENABLED env var (false at launch)
 *   - tenant_settings.customer_bug_flow_enabled (default TRUE when
 *     platform flag is TRUE — tenants opt their customers out via
 *     setting this to false; reads at recognizer time)
 *
 * The trigger phrases are seeded here and extensible via the
 * platform_settings.bug_intent_phrases JSONB column (operator can refine
 * without a code deploy).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Built-in phrase patterns. The operator can extend via DB. */
const SEED_PHRASES = [
  "this is broken",
  "something's wrong",
  "something is wrong",
  "i think there's a bug",
  "i think there is a bug",
  "this page is glitching",
  "the website crashed",
  "the site crashed",
  "not working right",
  "doesn't work",
  "does not work",
] as const;

export interface RecognizerOpts {
  message: string;
  tenant_id: string;
  db: SupabaseClient;
  /** Caller can pre-load extra phrases from platform_settings if cached;
   *  otherwise the recognizer reads them itself. */
  cachedExtraPhrases?: string[];
}

export const OFFER_MESSAGE =
  "It sounds like something might not be working right. Would you like me to file a bug report? I'll ask you a few quick questions and our engineering team will take a look.";

interface SettingsRow {
  value?: unknown;
}

async function loadExtraPhrases(db: SupabaseClient): Promise<string[]> {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "bug_intent_phrases")
    .maybeSingle();
  const value = (data as SettingsRow | null)?.value;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

async function tenantHasFeatureEnabled(db: SupabaseClient, tenant_id: string): Promise<boolean> {
  const { data } = await db
    .from("tenant_settings")
    .select("customer_bug_flow_enabled")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const value = (data as { customer_bug_flow_enabled?: boolean | null } | null)?.customer_bug_flow_enabled;
  // Default TRUE when platform flag is TRUE — the column may not exist on
  // existing tenant_settings rows, in which case `value` is undefined and
  // we treat it as opted-in.
  return value !== false;
}

/**
 * Returns true when the message looks like a bug-intent trigger AND both
 * gates pass (platform flag + tenant opt-in).
 *
 * Pure-ish: only touches `platform_settings.bug_intent_phrases` and
 * `tenant_settings.customer_bug_flow_enabled` reads. Caller invokes per
 * customer message; budget the two reads (cheap).
 */
export async function detectBugIntent(opts: RecognizerOpts): Promise<{
  triggered: boolean;
  matched_phrase?: string;
  offer_message?: string;
}> {
  if (!env().PHASE_2_CUSTOMER_BUG_FLOW_ENABLED) {
    return { triggered: false };
  }
  if (!(await tenantHasFeatureEnabled(opts.db, opts.tenant_id))) {
    return { triggered: false };
  }
  const haystack = opts.message.toLowerCase();
  const extra = opts.cachedExtraPhrases ?? (await loadExtraPhrases(opts.db));
  const allPhrases = [...SEED_PHRASES, ...extra];
  for (const phrase of allPhrases) {
    if (haystack.includes(phrase.toLowerCase())) {
      return { triggered: true, matched_phrase: phrase, offer_message: OFFER_MESSAGE };
    }
  }
  return { triggered: false };
}

/** Test-friendly: pure phrase-matching without DB reads. */
export function matchesAnySeedPhrase(message: string): string | null {
  const haystack = message.toLowerCase();
  for (const phrase of SEED_PHRASES) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}
