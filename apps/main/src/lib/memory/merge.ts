// §11.2.5 — Memory merge logic.
//
// Merges an extracted snapshot into the current memory row.
// Merge rules:
//   - Non-null extracted values overwrite current values (extracted wins on conflict).
//   - Null/undefined extracted fields do not overwrite existing current values (no erasure).
//   - JSONB array fields (loyalty_programs) are union'd by a stable key (program_code).
//     Unknown array fields fall back to extracted-wins (replace).
//   - Scalar JSONB objects are shallow-merged with extracted winning on key conflicts.

export interface CustomerMemoryFields {
  preferences?: Record<string, unknown> | null;
  travel_history?: Record<string, unknown> | null;
  family_composition?: unknown[] | null;
  accessibility_needs?: Record<string, unknown> | null;
  dietary_restrictions?: Record<string, unknown> | null;
  loyalty_programs?: LoyaltyProgram[] | null;
  important_dates?: Record<string, unknown> | null;
  notes_freeform?: string | null;
  rapport_tone_level?: number | null;
  rapport_signals?: Record<string, unknown> | null;
}

export interface LoyaltyProgram {
  program_code: string;
  member_number?: string;
  tier?: string;
  [key: string]: unknown;
}

/**
 * Merges extracted memory facts into the current memory row.
 * Returns the merged result — does not mutate either input.
 */
export function mergeMemory(
  current: CustomerMemoryFields,
  extracted: Partial<CustomerMemoryFields>,
): CustomerMemoryFields {
  const merged: CustomerMemoryFields = { ...current };

  for (const key of Object.keys(extracted) as (keyof CustomerMemoryFields)[]) {
    const extractedVal = extracted[key];

    // Skip null/undefined — do not erase existing data.
    if (extractedVal == null) continue;

    if (key === "loyalty_programs") {
      merged.loyalty_programs = mergeLoyaltyPrograms(
        current.loyalty_programs ?? [],
        extractedVal as LoyaltyProgram[],
      );
    } else if (key === "family_composition") {
      // Arrays without a stable unique key: extracted replaces current if non-empty.
      const arr = extractedVal as unknown[];
      merged.family_composition = arr.length > 0 ? arr : (current.family_composition ?? null);
    } else if (
      key === "notes_freeform" ||
      key === "rapport_tone_level"
    ) {
      // Scalar fields: extracted wins unconditionally when non-null.
      (merged as Record<string, unknown>)[key] = extractedVal;
    } else {
      // JSONB object fields: shallow-merge, extracted wins on key conflicts.
      const currentObj = (current[key] as Record<string, unknown> | null) ?? {};
      (merged as Record<string, unknown>)[key] = {
        ...currentObj,
        ...(extractedVal as Record<string, unknown>),
      };
    }
  }

  return merged;
}

/** Union loyalty_programs arrays by program_code. Extracted entry wins on conflict. */
function mergeLoyaltyPrograms(
  current: LoyaltyProgram[],
  extracted: LoyaltyProgram[],
): LoyaltyProgram[] {
  const map = new Map<string, LoyaltyProgram>();
  for (const entry of current) {
    map.set(entry.program_code, entry);
  }
  for (const entry of extracted) {
    // Extracted entry overwrites current for the same program_code.
    map.set(entry.program_code, { ...map.get(entry.program_code), ...entry });
  }
  return Array.from(map.values());
}
