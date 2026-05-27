// §24.5 — Customer-issued tone-change detection + persistence.
//
// Runs on every customer message. Deterministic phrase-match for explicit
// requests to change tone. Persisted via existing customer_memories table
// (BP12). The chat handler calls this before kicking off the AI response so
// the new tone takes effect on the same turn.
//
// Detection is intentionally conservative: only firm explicit requests are
// matched. Ambiguous phrasing is left for the customer memory extraction
// pipeline (BP12) to handle.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

export type ToneOverrideAction =
  | { kind: "bump_up" }
  | { kind: "bump_down" }
  | { kind: "set_direct" }
  | null;

const BUMP_UP_PATTERNS = [
  /\b(be|talk|chat|sound)\s+more\s+casual\b/i,
  /\b(lighten\s+up|loosen\s+up)\b/i,
  /\b(more\s+chill|less\s+formal|less\s+stiff)\b/i,
  /\b(relax|chill)\s+(out|a\s+bit)\b/i,
];

const BUMP_DOWN_PATTERNS = [
  /\b(be|talk|sound)\s+more\s+(professional|formal|serious)\b/i,
  /\b(tone\s+it\s+down|too\s+casual|too\s+informal)\b/i,
  /\b(more\s+polished|less\s+chatty)\b/i,
];

const SET_DIRECT_PATTERNS = [
  /\bcut\s+the\s+small\s+talk\b/i,
  /\bskip\s+the\s+pleasantries\b/i,
  /\bjust\s+(the\s+)?(facts|answer|info)\b/i,
  /\bget\s+(straight\s+)?to\s+the\s+point\b/i,
];

export function detectToneOverride(message: string): ToneOverrideAction {
  if (SET_DIRECT_PATTERNS.some((re) => re.test(message))) return { kind: "set_direct" };
  if (BUMP_DOWN_PATTERNS.some((re) => re.test(message))) return { kind: "bump_down" };
  if (BUMP_UP_PATTERNS.some((re) => re.test(message))) return { kind: "bump_up" };
  return null;
}

// Applies the override to customer_memories. Requires a service-role db
// because the chat handler runs as the customer but writes to a memory row
// that may not yet exist (UPSERT). Returns the new resolved tone level (or
// null if no row was found and we created nothing).
export async function applyToneOverride(
  db: SupabaseClient,
  args: {
    tenant_id: string;
    user_id: string;
    action: NonNullable<ToneOverrideAction>;
    tenant_max_level: number;
  },
): Promise<{ new_level: number | null; new_directive: "direct" | null }> {
  const { data: existing } = await db
    .from("customer_memories")
    .select("rapport_tone_level, rapport_tone_directive")
    .eq("tenant_id", args.tenant_id)
    .eq("user_id", args.user_id)
    .maybeSingle();

  const currentLevel = (existing as { rapport_tone_level?: number } | null)?.rapport_tone_level ?? 3;
  const currentDirective = (existing as { rapport_tone_directive?: "direct" } | null)?.rapport_tone_directive ?? null;

  let nextLevel = currentLevel;
  let nextDirective = currentDirective;

  switch (args.action.kind) {
    case "bump_up":
      nextLevel = Math.min(args.tenant_max_level, currentLevel + 1);
      nextDirective = null; // bumping up implies we want warmth back
      break;
    case "bump_down":
      nextLevel = Math.max(1, currentLevel - 1);
      break;
    case "set_direct":
      nextLevel = Math.min(2, args.tenant_max_level);
      nextDirective = "direct";
      break;
  }

  if (existing) {
    await safeAwait(db
      .from("customer_memories")
      .update({
        rapport_tone_level: nextLevel,
        rapport_tone_directive: nextDirective,
        rapport_level_set_at: new Date().toISOString(),
      })
      .eq("tenant_id", args.tenant_id)
      .eq("user_id", args.user_id), "customer_memories.update");
  } else {
    await safeAwait(db.from("customer_memories").insert({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      rapport_tone_level: nextLevel,
      rapport_tone_directive: nextDirective,
      rapport_level_set_at: new Date().toISOString(),
    }), "customer_memories.insert");
  }

  return { new_level: nextLevel, new_directive: nextDirective };
}
