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
 *
 * (#1190: the per-tenant `tenant_settings.customer_bug_flow_enabled` opt-out was
 * never migrated and is dropped — the flow is gated by the platform flag only.)
 *
 * The trigger phrases are seeded here and extensible via the
 * platform_settings.bug_intent_phrases JSONB column (operator can refine
 * without a code deploy).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { getCachedPlatformSetting } from "@/lib/platform/platform-setting-cache";

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
  db: SupabaseClient;
  /** Caller can pre-load extra phrases from platform_settings if cached;
   *  otherwise the recognizer reads them itself. */
  cachedExtraPhrases?: string[];
}

export const OFFER_MESSAGE =
  "It sounds like something might not be working right. Would you like me to file a bug report? I'll ask you a few quick questions and our engineering team will take a look.";

async function loadExtraPhrases(db: SupabaseClient): Promise<string[]> {
  // #1586 — served from the shared 60s platform_settings cache. Error ignored
  // (best-effort phrase list); the seed phrases still apply.
  const { value } = await getCachedPlatformSetting(db, "bug_intent_phrases");
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Returns true when the message looks like a bug-intent trigger AND the
 * platform flag is enabled.
 *
 * Pure-ish: only touches `platform_settings.bug_intent_phrases`. Caller invokes
 * per customer message; budget the one read (cheap).
 */
export async function detectBugIntent(opts: RecognizerOpts): Promise<{
  triggered: boolean;
  matched_phrase?: string;
  offer_message?: string;
}> {
  if (!env().PHASE_2_CUSTOMER_BUG_FLOW_ENABLED) {
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
