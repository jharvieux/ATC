// #903 — Voice profile resolution order + fail-closed behavior.
// The Phase 3 draft composer calls this; the property that matters is:
// own profile first, house style fallback, null when neither exists,
// and fail-closed (null) on DB errors so Phase 3 always has a safe fallback.

import { describe, it, expect } from "vitest";
import { resolveVoiceProfile } from "@/lib/voice-profiles/resolve-voice-profile";
import type { SupabaseClient } from "@supabase/supabase-js";

function dbStub(rows: Record<string | symbol, unknown> | null, error?: { message: string }): SupabaseClient {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "is"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: error ? null : rows, error: error ?? null });
  return { from: () => chain } as unknown as SupabaseClient;
}

const OWN_CARD = { style_card: { greeting: "Hi {first}," }, card_override: null };
const HOUSE_CARD = { style_card: { greeting: "Dear {full_name}," }, card_override: "House style" };

describe("resolveVoiceProfile (#903)", () => {
  it("returns own profile when user has one", async () => {
    const db = dbStub(OWN_CARD);
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result).not.toBeNull();
    expect(result?.source).toBe("own");
    expect(result?.style_card).toEqual(OWN_CARD.style_card);
  });

  it("house fallback when user has no profile", async () => {
    // First call (own) returns null; second call (house) returns data.
    let callCount = 0;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "is"]) chain[m] = () => chain;
    chain.maybeSingle = async () => {
      callCount++;
      return { data: callCount === 1 ? null : HOUSE_CARD, error: null };
    };
    const db = { from: () => chain } as unknown as SupabaseClient;

    const result = await resolveVoiceProfile(db, "users-1");
    expect(result?.source).toBe("house");
    expect(result?.card_override).toBe("House style");
  });

  it("returns null when neither own nor house profile exists", async () => {
    const db = dbStub(null);
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result).toBeNull();
  });

  it("fails closed on DB error — returns null, never throws", async () => {
    const db = dbStub(null, { message: "db down" });
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result).toBeNull();
  });

  it("null publicUserId → skips own profile, tries house only", async () => {
    const db = dbStub(HOUSE_CARD);
    const result = await resolveVoiceProfile(db, null);
    expect(result?.source).toBe("house");
  });
});
