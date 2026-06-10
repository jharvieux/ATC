// #903 — Voice profile resolution order + fail-closed behavior.
// The Phase 3 draft composer calls this; the property that matters is:
// own profile first, house style fallback, null when neither exists,
// and fail-closed (null) on DB errors so Phase 3 always has a safe fallback.
//
// The stub captures which filter method was called (.eq vs .is) so the test
// can verify the operator-selection fix (blocker from D-091 audit: .is() only
// works for null/boolean; UUID lookups must use .eq()).

import { describe, it, expect } from "vitest";
import { resolveVoiceProfile } from "@/lib/voice-profiles/resolve-voice-profile";
import type { SupabaseClient } from "@supabase/supabase-js";

type FilterCall = { method: "eq" | "is"; column: string; value: unknown };

function dbStub(
  rows: Record<string, unknown> | null,
  error?: { message: string },
): { db: SupabaseClient; filterCalls: FilterCall[] } {
  const filterCalls: FilterCall[] = [];
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => { filterCalls.push({ method: "eq", column: col, value: val }); return chain; };
  chain.is = (col: string, val: unknown) => { filterCalls.push({ method: "is", column: col, value: val }); return chain; };
  chain.maybeSingle = async () => ({ data: error ? null : rows, error: error ?? null });
  return { db: chain as unknown as SupabaseClient, filterCalls };
}

const OWN_CARD = { style_card: { greeting: "Hi {first}," }, card_override: null };
const HOUSE_CARD = { style_card: { greeting: "Dear {full_name}," }, card_override: "House style" };

describe("resolveVoiceProfile (#903)", () => {
  it("returns own profile when user has one", async () => {
    const { db } = dbStub(OWN_CARD);
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result?.source).toBe("own");
    expect(result?.style_card).toEqual(OWN_CARD.style_card);
  });

  it("uses .eq() not .is() for non-null user_id (operator fix from audit)", async () => {
    const { db, filterCalls } = dbStub(OWN_CARD);
    await resolveVoiceProfile(db, "users-uuid-123");
    const userIdFilter = filterCalls.find((c) => c.column === "user_id");
    expect(userIdFilter?.method).toBe("eq");
  });

  it("uses .is() for null user_id (house style path)", async () => {
    const { db, filterCalls } = dbStub(HOUSE_CARD);
    await resolveVoiceProfile(db, null);
    const userIdFilter = filterCalls.find((c) => c.column === "user_id");
    expect(userIdFilter?.method).toBe("is");
    expect(userIdFilter?.value).toBeNull();
  });

  it("house fallback when user has no profile", async () => {
    let callCount = 0;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "is"]) chain[m] = () => chain;
    chain.maybeSingle = async () => {
      callCount++;
      return { data: callCount === 1 ? null : HOUSE_CARD, error: null };
    };
    const db = chain as unknown as SupabaseClient;
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result?.source).toBe("house");
    expect(result?.card_override).toBe("House style");
  });

  it("returns null when neither own nor house profile exists", async () => {
    const { db } = dbStub(null);
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result).toBeNull();
  });

  it("fails closed on DB error — returns null, never throws", async () => {
    const { db } = dbStub(null, { message: "db down" });
    const result = await resolveVoiceProfile(db, "users-1");
    expect(result).toBeNull();
  });

  it("null publicUserId → skips own profile, tries house only", async () => {
    const { db } = dbStub(HOUSE_CARD);
    const result = await resolveVoiceProfile(db, null);
    expect(result?.source).toBe("house");
  });
});
