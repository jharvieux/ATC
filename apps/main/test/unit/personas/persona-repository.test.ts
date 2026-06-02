// §9.3 / D-138 — persona-repository hot-path read contract.
//
// These tests pin the behavior buildSystemPrompt depends on every chat turn:
//   - success maps the row -> PersonaRecord and passes `version` through
//     (the prompt cacheKey folds version in, so a wrong version silently
//      poisons the Anthropic prompt cache)
//   - the 60s cache is honored (one DB hit) and expires (re-query)
//   - DB error / missing row falls back to the code default at version 0,
//     and the fallback is NOT cached (next turn retries + recovers)
//   - a slug with no DB row AND no code default is a genuinely unknown
//     persona and MUST throw (matches pre-DB behavior)
//   - getSafetyConfig has the same cache + fallback contract

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getPersonaForPrompt,
  getSafetyConfig,
  clearPersonaRepositoryCaches,
} from "@/lib/personas/persona-repository";
import { getPersonaDefault } from "@/lib/personas/persona-defaults";
import { SAFETY_EDITABLE_DEFAULT } from "@/lib/personas/platform-constraints";

type QueryResult = { data: unknown; error: { message: string } | null };

// Mocks the `from(table).select(cols).eq(col,val).maybeSingle()` chain used by
// both reads, and records how many times each table was queried so the cache
// behavior is observable.
function makeDb(responses: Record<string, () => QueryResult>) {
  const calls: Record<string, number> = {};
  const db = {
    from(table: string) {
      calls[table] = (calls[table] ?? 0) + 1;
      const responder = responses[table];
      if (!responder) throw new Error(`unexpected table in test mock: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => responder(),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function personaRow(over: Record<string, unknown> = {}) {
  return {
    slug: "marcus-cole",
    kind: "travel_concierge",
    display_name: "Marcus Cole",
    tagline: "Your luxury travel expert",
    specialty: "luxury travel",
    background: "You are Marcus.",
    voice: "warm",
    tone_style: "polished",
    expertise_primary: "luxury",
    expertise_secondary: "honeymoons",
    expertise_fallback_note: null,
    anti_instructions: ["never overbook"],
    disclosure_pattern: "disclose AI",
    prompt_body: "Body text.",
    tone_calibration_placeholder: "{{TONE_CALIBRATION}}",
    version: 7,
    ...over,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearPersonaRepositoryCaches();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

describe("getPersonaForPrompt", () => {
  it("maps the DB row to a PersonaRecord and passes version through", async () => {
    const { db } = makeDb({ personas: () => ({ data: personaRow({ version: 7 }), error: null }) });

    const result = await getPersonaForPrompt("marcus-cole", db);

    expect(result.version).toBe(7);
    expect(result.persona.slug).toBe("marcus-cole");
    expect(result.persona.kind).toBe("travel_concierge");
    expect(result.persona.anti_instructions).toEqual(["never overbook"]);
    expect(result.persona.expertise_fallback_note).toBeNull();
    // version rides on LoadedPersona, NOT on the PersonaRecord handed to assembly.
    expect("version" in result.persona).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("serves a second read from the 60s cache (one DB hit)", async () => {
    const { db, calls } = makeDb({ personas: () => ({ data: personaRow(), error: null }) });

    await getPersonaForPrompt("marcus-cole", db);
    await getPersonaForPrompt("marcus-cole", db);

    expect(calls.personas).toBe(1);
  });

  it("re-queries the DB after the TTL expires", async () => {
    vi.useFakeTimers();
    const { db, calls } = makeDb({ personas: () => ({ data: personaRow(), error: null }) });

    await getPersonaForPrompt("marcus-cole", db);
    await getPersonaForPrompt("marcus-cole", db);
    expect(calls.personas).toBe(1);

    vi.advanceTimersByTime(60_001);
    await getPersonaForPrompt("marcus-cole", db);
    expect(calls.personas).toBe(2);
  });

  it("falls back to the code default at version 0 on a read error, and does NOT cache it", async () => {
    const { db, calls } = makeDb({
      personas: () => ({ data: null, error: { message: "connection reset" } }),
    });

    const result = await getPersonaForPrompt("marcus-cole", db);

    expect(result.version).toBe(0);
    expect(result.persona).toEqual(getPersonaDefault("marcus-cole"));
    expect(warnSpy).toHaveBeenCalledOnce();

    // Fallback is not cached: the next turn retries the DB.
    await getPersonaForPrompt("marcus-cole", db);
    expect(calls.personas).toBe(2);
  });

  it("falls back to the code default on a missing row (no error, no data)", async () => {
    const { db } = makeDb({ personas: () => ({ data: null, error: null }) });

    const result = await getPersonaForPrompt("marcus-cole", db);

    expect(result.version).toBe(0);
    expect(result.persona).toEqual(getPersonaDefault("marcus-cole"));
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("throws for an unknown slug with no DB row and no code default", async () => {
    const { db } = makeDb({ personas: () => ({ data: null, error: null }) });

    await expect(getPersonaForPrompt("ghost-persona", db)).rejects.toThrow(
      /Unknown persona slug 'ghost-persona'/,
    );
  });
});

describe("getSafetyConfig", () => {
  it("returns the editable block + version from the DB", async () => {
    const { db } = makeDb({
      persona_safety_config: () => ({
        data: { editable_block: "EDITABLE SAFETY TEXT", version: 4 },
        error: null,
      }),
    });

    const result = await getSafetyConfig(db);

    expect(result).toEqual({ editable_block: "EDITABLE SAFETY TEXT", version: 4 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("caches the safety block for 60s (one DB hit)", async () => {
    const { db, calls } = makeDb({
      persona_safety_config: () => ({
        data: { editable_block: "EDITABLE SAFETY TEXT", version: 4 },
        error: null,
      }),
    });

    await getSafetyConfig(db);
    await getSafetyConfig(db);

    expect(calls.persona_safety_config).toBe(1);
  });

  it("falls back to SAFETY_EDITABLE_DEFAULT at version 0 on error, and does NOT cache it", async () => {
    const { db, calls } = makeDb({
      persona_safety_config: () => ({ data: null, error: { message: "timeout" } }),
    });

    const result = await getSafetyConfig(db);

    expect(result).toEqual({ editable_block: SAFETY_EDITABLE_DEFAULT, version: 0 });
    expect(warnSpy).toHaveBeenCalledOnce();

    await getSafetyConfig(db);
    expect(calls.persona_safety_config).toBe(2);
  });

  it("falls back to SAFETY_EDITABLE_DEFAULT on a missing row", async () => {
    const { db } = makeDb({
      persona_safety_config: () => ({ data: null, error: null }),
    });

    const result = await getSafetyConfig(db);

    expect(result).toEqual({ editable_block: SAFETY_EDITABLE_DEFAULT, version: 0 });
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
