// D-138 §9.3 — admin-edit support for DB-backed personas + the editable safety
// block. Single source of truth for: which persona fields an admin may edit,
// how a PUT body is validated, and the version-bumped CAS writes the admin API
// performs against the service-role client.
//
// NOT editable (and absent from PERSONA_EDITABLE_COLUMNS):
//   - slug, kind          identity / structural discriminator
//   - version             server-managed (bumped on every write for cache
//                         invalidation + optimistic concurrency)
//   - sort_order, is_active   list-presentation knobs, not prompt content
//   - tone_calibration_placeholder   a structural token the assembler
//                         substitutes; editing it would silently break tone
//                         injection (the {{TONE_CALIBRATION}} marker).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonaRecord } from "./assemble-persona-prompt";
import { safeAwait, safeAwaitRowCount } from "@/lib/db/safe-mutation";

export const PERSONA_EDITABLE_COLUMNS = [
  "display_name",
  "tagline",
  "specialty",
  "background",
  "voice",
  "tone_style",
  "expertise_primary",
  "expertise_secondary",
  "expertise_fallback_note",
  "anti_instructions",
  "disclosure_pattern",
  "prompt_body",
] as const;

export type PersonaEditableColumn = (typeof PERSONA_EDITABLE_COLUMNS)[number];

// Detail GET projection: identity + server-managed version + the editable set.
export const PERSONA_DETAIL_COLUMNS = `slug, kind, version, ${PERSONA_EDITABLE_COLUMNS.join(", ")}`;

// List GET projection: enough to render the list + open the editor.
export const PERSONA_LIST_COLUMNS =
  "slug, kind, display_name, tagline, specialty, is_active, sort_order, version";

// Non-empty after trim — a blank display name or prompt body would produce a
// degenerate Layer-1 prompt.
const REQUIRED_NONEMPTY: ReadonlySet<string> = new Set(["display_name", "prompt_body"]);
// Non-null string that MAY be empty (help_ai seeds background = "").
const PLAIN_STRING: ReadonlySet<string> = new Set(["background"]);
// Everything else in the editable set is string | null, except
// anti_instructions which is string[] (handled explicitly below).

export type PersonaValidation =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string; field?: string };

/**
 * Validates a persona PUT body against the editable whitelist. Accepts any
 * SUBSET of editable columns (so the editor can PATCH a single field), but
 * requires at least one. Unknown keys are ignored, not errored.
 */
export function validatePersonaPatch(body: unknown): PersonaValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const col of PERSONA_EDITABLE_COLUMNS) {
    if (!(col in input)) continue;
    const v = input[col];

    if (col === "anti_instructions") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return { ok: false, error: "anti_instructions must be an array of strings", field: col };
      }
      patch[col] = v;
    } else if (PLAIN_STRING.has(col)) {
      if (typeof v !== "string") return { ok: false, error: `${col} must be a string`, field: col };
      patch[col] = v;
    } else if (REQUIRED_NONEMPTY.has(col)) {
      if (typeof v !== "string" || v.trim().length === 0) {
        return { ok: false, error: `${col} must be a non-empty string`, field: col };
      }
      patch[col] = v;
    } else {
      // string | null
      if (v !== null && typeof v !== "string") {
        return { ok: false, error: `${col} must be a string or null`, field: col };
      }
      patch[col] = v;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "no editable fields provided" };
  }
  return { ok: true, patch };
}

/** Full editable-field payload from a code-default PersonaRecord (restore = full reset). */
export function personaDefaultPatch(p: PersonaRecord): Record<string, unknown> {
  return {
    display_name: p.display_name,
    tagline: p.tagline,
    specialty: p.specialty,
    background: p.background,
    voice: p.voice,
    tone_style: p.tone_style,
    expertise_primary: p.expertise_primary,
    expertise_secondary: p.expertise_secondary,
    expertise_fallback_note: p.expertise_fallback_note,
    anti_instructions: p.anti_instructions,
    disclosure_pattern: p.disclosure_pattern,
    prompt_body: p.prompt_body,
  };
}

/**
 * Applies an editable-field patch to a persona row with a version-CAS bump
 * (D-091: zero-row CAS must raise, not silently no-op). Returns the new version
 * on success, or `{ notFound: true }` when no row matches the slug. The caller
 * is responsible for clearing the hot-path cache after a successful write.
 */
export async function applyPersonaPatch(
  db: SupabaseClient,
  slug: string,
  patch: Record<string, unknown>,
  updatedBy: string | null,
): Promise<{ version: number } | { notFound: true }> {
  const cur = await safeAwait(
    db.from("personas").select("version").eq("slug", slug).maybeSingle(),
    "personas.read.version",
  );
  if (!cur) return { notFound: true };
  const current = Number((cur as { version: number }).version);
  const next = current + 1;

  await safeAwaitRowCount(
    db
      .from("personas")
      .update({ ...patch, version: next, updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq("slug", slug)
      .eq("version", current)
      .select("slug"),
    "personas.update.cas",
    1,
  );
  return { version: next };
}

/**
 * Sets the singleton editable safety block with a version-CAS bump. The
 * 'default' row is seeded by migration; a missing row is an invariant break and
 * raises. Caller clears the hot-path cache after success.
 */
export async function applySafetyPatch(
  db: SupabaseClient,
  editableBlock: string,
  updatedBy: string | null,
): Promise<{ version: number }> {
  const cur = await safeAwait(
    db.from("persona_safety_config").select("version").eq("id", "default").maybeSingle(),
    "persona_safety_config.read.version",
  );
  if (!cur) throw new Error("persona_safety_config 'default' row missing (seed invariant)");
  const current = Number((cur as { version: number }).version);
  const next = current + 1;

  await safeAwaitRowCount(
    db
      .from("persona_safety_config")
      .update({ editable_block: editableBlock, version: next, updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq("id", "default")
      .eq("version", current)
      .select("id"),
    "persona_safety_config.update.cas",
    1,
  );
  return { version: next };
}
