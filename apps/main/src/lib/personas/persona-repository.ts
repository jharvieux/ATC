// §9.3 / D-138 — hot-path reads for DB-backed personas + the editable safety block.
//
// buildSystemPrompt calls these on every chat turn, so each lookup is wrapped in
// a best-effort 60s in-memory cache (per-instance, like resolve-tenant.ts).
//
// Fallback contract: prompt construction is NOT an enforcement gate. On a DB
// miss or error the read falls back to the code-side default (PERSONA_DEFAULTS /
// SAFETY_EDITABLE_DEFAULT) and logs a warning — chat must never hard-fail on a
// transient read problem, the defaults are the vetted baseline, and the legal
// kernel is always code-side regardless (platform-constraints.ts). The only hard
// error is a slug with no DB row AND no code default — that is a genuinely
// unknown persona, which must surface (matches the pre-DB behavior).
//
// `version` rides alongside each value so buildSystemPrompt can fold it into the
// Anthropic prompt cacheKey: an admin edit bumps version, which invalidates the
// prompt cache. Fallbacks report version 0 (stable: the code default never
// changes at runtime), so the cache flips back to the real version on recovery.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type PersonaRecord } from "./assemble-persona-prompt";
import { getPersonaDefault } from "./persona-defaults";
import { SAFETY_EDITABLE_DEFAULT } from "./platform-constraints";

export type LoadedPersona = { persona: PersonaRecord; version: number };
export type LoadedSafety = { editable_block: string; version: number };

const TTL_MS = 60_000;

type Entry<T> = { value: T; expiresAt: number };

const personaCache = new Map<string, Entry<LoadedPersona>>();
let safetyEntry: Entry<LoadedSafety> | null = null;

function fresh<T>(entry: Entry<T> | null | undefined): T | undefined {
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) return undefined;
  return entry.value;
}

/** Clears both caches. Best-effort same-instance freshness for the admin write
 *  path + a clean slate for tests. Cross-instance invalidation is TTL-bounded. */
export function clearPersonaRepositoryCaches(): void {
  personaCache.clear();
  safetyEntry = null;
}

const PERSONA_COLUMNS =
  "slug, kind, display_name, tagline, specialty, background, voice, tone_style, " +
  "expertise_primary, expertise_secondary, expertise_fallback_note, anti_instructions, " +
  "disclosure_pattern, prompt_body, tone_calibration_placeholder, version";

interface PersonaRow {
  slug: string;
  kind: string;
  display_name: string;
  tagline: string | null;
  specialty: string | null;
  background: string;
  voice: string | null;
  tone_style: string | null;
  expertise_primary: string | null;
  expertise_secondary: string | null;
  expertise_fallback_note: string | null;
  anti_instructions: string[];
  disclosure_pattern: string | null;
  prompt_body: string;
  tone_calibration_placeholder: string;
  version: number;
}

function rowToPersona(row: PersonaRow): PersonaRecord {
  return {
    slug: row.slug,
    kind: row.kind,
    display_name: row.display_name,
    tagline: row.tagline,
    specialty: row.specialty,
    background: row.background,
    voice: row.voice,
    tone_style: row.tone_style,
    expertise_primary: row.expertise_primary,
    expertise_secondary: row.expertise_secondary,
    expertise_fallback_note: row.expertise_fallback_note,
    anti_instructions: row.anti_instructions,
    disclosure_pattern: row.disclosure_pattern,
    prompt_body: row.prompt_body,
    tone_calibration_placeholder: row.tone_calibration_placeholder,
  };
}

function personaFallback(slug: string, reason: string): LoadedPersona {
  const def = getPersonaDefault(slug);
  if (!def) {
    throw new Error(`Unknown persona slug '${slug}' (no DB row and no code default; ${reason})`);
  }
  console.warn(`[persona-repository] persona ${JSON.stringify(slug)} falling back to code default: ${String(reason).replace(/[\r\n]+/g, " ")}`);
  return { persona: def, version: 0 };
}

/**
 * Loads a persona by slug for prompt assembly. Reads through the caller's
 * Supabase client (personas is authenticated-readable), caches success for 60s,
 * and falls back to the code default on miss/error. Fallbacks are NOT cached so
 * the next turn retries the DB and recovers immediately.
 */
export async function getPersonaForPrompt(
  slug: string,
  db: SupabaseClient,
): Promise<LoadedPersona> {
  const cached = fresh(personaCache.get(slug));
  if (cached !== undefined) return cached;

  const { data, error } = await db
    .from("personas")
    .select(PERSONA_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) return personaFallback(slug, `read error: ${error.message}`);
  if (!data) return personaFallback(slug, "no row in personas table");

  const row = data as unknown as PersonaRow;
  const loaded: LoadedPersona = {
    persona: rowToPersona(row),
    version: Number(row.version),
  };
  personaCache.set(slug, { value: loaded, expiresAt: Date.now() + TTL_MS });
  return loaded;
}

/**
 * Loads the singleton editable safety block. Same cache + fallback contract as
 * getPersonaForPrompt. The returned block is the EDITABLE half only; the caller
 * prepends the code-side LEGAL_KERNEL via assemblePlatformConstraints().
 */
export async function getSafetyConfig(db: SupabaseClient): Promise<LoadedSafety> {
  const cached = fresh(safetyEntry);
  if (cached !== undefined) return cached;

  const { data, error } = await db
    .from("persona_safety_config")
    .select("editable_block, version")
    .eq("id", "default")
    .maybeSingle();

  if (error || !data) {
    console.warn(
      `[persona-repository] safety config falling back to code default: ${error?.message ?? "no row"}`,
    );
    return { editable_block: SAFETY_EDITABLE_DEFAULT, version: 0 };
  }

  const loaded: LoadedSafety = {
    editable_block: data.editable_block as string,
    version: Number(data.version),
  };
  safetyEntry = { value: loaded, expiresAt: Date.now() + TTL_MS };
  return loaded;
}
