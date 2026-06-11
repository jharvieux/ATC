// §781 Phase 2 — resolve free-text cruise line / ship name to a canonical FK.
//
// Pipeline: normalize → exact match → alias lookup → safe variants.
// Never auto-applies below alias confidence — unmatched returns { matched: false }.
// Call sites that want to record unmatched values for admin review should use
// queueForReview() separately (service-role only; not called from API routes).

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeForMatch, safeVariants } from "./normalize-string";

export type CanonicalEntityType = "line" | "ship";

export type ResolveResult =
  | { matched: true; id: string }
  | { matched: false };

export async function resolveCanonical(
  raw: string | null | undefined,
  entityType: CanonicalEntityType,
  db: SupabaseClient,
): Promise<ResolveResult> {
  if (!raw?.trim()) return { matched: false };

  const norm = normalizeForMatch(raw);
  const variants = safeVariants(norm);

  if (entityType === "line") {
    // Exact match against slug / canonical_name / display_name.
    const { data: lines } = await db
      .from("cruise_lines")
      .select("id, slug, canonical_name, display_name")
      .eq("is_active", true);

    if (lines) {
      for (const v of variants) {
        for (const line of lines) {
          if (
            normalizeForMatch(line.slug) === v ||
            normalizeForMatch(line.canonical_name) === v ||
            normalizeForMatch(line.display_name) === v
          ) {
            return { matched: true, id: line.id };
          }
        }
      }
    }

    // Alias lookup — all variants.
    for (const v of variants) {
      const { data: alias } = await db
        .from("cruise_line_aliases")
        .select("cruise_line_id")
        .eq("alias_normalized", v)
        .maybeSingle();

      if (alias?.cruise_line_id) return { matched: true, id: alias.cruise_line_id };
    }
  } else {
    // Ships: alias lookup first (canonical_name / slug also checked as fallback).
    for (const v of variants) {
      const { data: alias } = await db
        .from("cruise_ship_aliases")
        .select("cruise_ship_id")
        .eq("alias_normalized", v)
        .maybeSingle();

      if (alias?.cruise_ship_id) return { matched: true, id: alias.cruise_ship_id };
    }

    const { data: ships } = await db
      .from("cruise_ships")
      .select("id, slug, canonical_name")
      .eq("is_active", true);

    if (ships) {
      for (const v of variants) {
        for (const ship of ships) {
          if (
            normalizeForMatch(ship.slug) === v ||
            normalizeForMatch(ship.canonical_name) === v
          ) {
            return { matched: true, id: ship.id };
          }
        }
      }
    }
  }

  return { matched: false };
}

// queueForReview — upserts an unmatched value to canonical_match_reviews.
// Service-role only. Best-effort: caller should not throw if this fails.
// Idempotent: duplicate (entity_type, value_normalized) pairs are ignored.
export async function queueForReview(
  raw: string,
  entityType: CanonicalEntityType,
  source: { table: string; column: string },
  svc: SupabaseClient,
): Promise<void> {
  const norm = normalizeForMatch(raw);
  const { error } = await svc
    .from("canonical_match_reviews")
    .upsert(
      {
        entity_type: entityType,
        value_normalized: norm,
        value_raw: raw.trim(),
        source_table: source.table,
        source_column: source.column,
      },
      { onConflict: "entity_type,value_normalized", ignoreDuplicates: true },
    );
  if (error) {
    console.error("canonical_match_reviews.upsert failed", error.message);
  }
}
