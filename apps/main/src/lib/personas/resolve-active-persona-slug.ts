// §24.6 — Resolve the persona slug a chat turn should speak as.
//
// Precedence (highest first):
//   1. The conversation's active_persona_id — set by the persona-switch
//      endpoint and authoritative across turns. A customer who switched
//      personas keeps that persona even if the client sends a stale
//      persona_slug in the body. It's a personas.id UUID, resolved here to a
//      slug for the downstream prompt/RAG/tone path.
//   2. The request body's persona_slug — only used when the conversation has
//      never switched (e.g. the very first turn).
//   3. DEFAULT_PERSONA_SLUG — final fallback.
//
// Extracted from the chat handler so the precedence is unit-testable on its
// own: the regression this guards against is the handler loading
// active_persona_id and then ignoring it (the body or default winning over a
// real switch). The personas read is best-effort — chat must not hard-fail on
// a transient read, so an unresolvable id falls through to the next level.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PERSONA_SLUG } from "./build-system-prompt";

export async function resolveActivePersonaSlug(
  db: SupabaseClient,
  opts: { activePersonaId: string | null; requestedSlug: string | null },
): Promise<string> {
  if (opts.activePersonaId) {
    const { data, error } = await db
      .from("personas")
      .select("slug")
      .eq("id", opts.activePersonaId)
      .maybeSingle();
    if (error) {
      console.warn(
        `[resolve-active-persona] id→slug read failed for ${opts.activePersonaId}, falling back: ${error.message}`,
      );
    }
    const slug = (data as { slug?: string } | null)?.slug;
    if (slug) return slug;
  }
  return opts.requestedSlug ?? DEFAULT_PERSONA_SLUG;
}
