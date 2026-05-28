// §18.10 — assertGroupNotSailed enforces read-only after a group sails.
//
// Fail-closed: a lookup error or missing row throws (not "gate passed"),
// otherwise an attacker who could prevent the row from being read could
// also bypass the gate.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";

function fakeDb(opts: { status?: string; sailed_at?: string | null; error?: { message: string } | null; data?: null }): SupabaseClient {
  return {
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (_col: string, _v: unknown) => ({
          maybeSingle: async () => {
            if (opts.error) return { data: null, error: opts.error };
            if (opts.data === null) return { data: null, error: null };
            return { data: { status: opts.status ?? "active", sailed_at: opts.sailed_at ?? null }, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("assertGroupNotSailed", () => {
  it("resolves silently for an active group", async () => {
    const db = fakeDb({ status: "active" });
    await expect(assertGroupNotSailed(db, "g1")).resolves.toBeUndefined();
  });

  it("resolves silently for a planning group", async () => {
    const db = fakeDb({ status: "planning" });
    await expect(assertGroupNotSailed(db, "g1")).resolves.toBeUndefined();
  });

  it("throws GroupSailedError for a sailed group", async () => {
    const sailedAt = "2026-05-01T00:00:00Z";
    const db = fakeDb({ status: "sailed", sailed_at: sailedAt });
    await expect(assertGroupNotSailed(db, "g1")).rejects.toMatchObject({
      name: "GroupSailedError",
      group_id: "g1",
      sailed_at: sailedAt,
    });
  });

  it("fail-closed: throws on lookup error (NOT silently passes)", async () => {
    const db = fakeDb({ error: { message: "PG timeout" } });
    await expect(assertGroupNotSailed(db, "g1")).rejects.toThrow(/group_sailed_lookup_failed/);
  });

  it("fail-closed: throws on missing group row", async () => {
    const db = fakeDb({ data: null });
    await expect(assertGroupNotSailed(db, "missing")).rejects.toThrow(/group_sailed_lookup_failed/);
  });

  it("GroupSailedError is instance-checkable so callers can catch it specifically", async () => {
    const db = fakeDb({ status: "sailed", sailed_at: null });
    try {
      await assertGroupNotSailed(db, "g1");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GroupSailedError);
      // Allows callers to do `if (e instanceof GroupSailedError) { return 410 }`
    }
  });
});
