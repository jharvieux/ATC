// D-138 §9.3 — admin-edit validation + version-CAS write contract.
//
// These tests pin the rules the admin API depends on:
//   - validatePersonaPatch is the editable WHITELIST. slug/kind/version are
//     never writable through it; required fields can't be blanked (a blank
//     display_name/prompt_body produces a degenerate Layer-1 prompt). A wrong
//     whitelist is a privilege/identity bug, not a cosmetic one.
//   - applyPersonaPatch / applySafetyPatch are version-CAS writes: a zero-row
//     update MUST raise (D-091), and a missing row is reported (persona) or
//     thrown (safety seed invariant) rather than silently no-op'd.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validatePersonaPatch,
  personaDefaultPatch,
  applyPersonaPatch,
  applySafetyPatch,
  PERSONA_EDITABLE_COLUMNS,
} from "@/lib/personas/persona-admin";
import { getPersonaDefault } from "@/lib/personas/persona-defaults";

// Mock the two chains persona-admin uses:
//   read:  from(t).select("version").eq(col,val).maybeSingle()
//   write: from(t).update(payload).eq(col,val).eq(col,val).select(cols)  -> array
function makeDb(opts: {
  versionRow?: { version: number } | null;
  versionError?: { message: string } | null;
  updateRows?: unknown[];
  updateError?: { message: string } | null;
}) {
  const calls = { update: 0 };
  let lastUpdatePayload: Record<string, unknown> | null = null;
  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: opts.versionRow ?? null,
                  error: opts.versionError ?? null,
                }),
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          calls.update++;
          lastUpdatePayload = payload;
          return {
            eq() {
              return {
                eq() {
                  return {
                    select: () =>
                      Promise.resolve({
                        data: opts.updateRows ?? [],
                        error: opts.updateError ?? null,
                      }),
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls, getLastUpdatePayload: () => lastUpdatePayload };
}

describe("validatePersonaPatch", () => {
  it("rejects a non-object body", () => {
    expect(validatePersonaPatch(null).ok).toBe(false);
    expect(validatePersonaPatch([]).ok).toBe(false);
    expect(validatePersonaPatch("nope").ok).toBe(false);
  });

  it("rejects a body with no editable fields", () => {
    const r = validatePersonaPatch({});
    expect(r).toEqual({ ok: false, error: "no editable fields provided" });
  });

  it("accepts a single-field subset (the editor PATCHes one field at a time)", () => {
    const r = validatePersonaPatch({ tagline: "New tagline" });
    expect(r).toEqual({ ok: true, patch: { tagline: "New tagline" } });
  });

  it("ignores non-editable keys — slug/kind/version can never be written", () => {
    const r = validatePersonaPatch({ slug: "hacked", kind: "platform_help", version: 99, tagline: "ok" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch).toEqual({ tagline: "ok" });
      expect("slug" in r.patch).toBe(false);
      expect("kind" in r.patch).toBe(false);
      expect("version" in r.patch).toBe(false);
    }
  });

  it("rejects a blank required field (display_name)", () => {
    const r = validatePersonaPatch({ display_name: "   " });
    expect(r).toMatchObject({ ok: false, field: "display_name" });
  });

  it("rejects a blank required field (prompt_body)", () => {
    const r = validatePersonaPatch({ prompt_body: "" });
    expect(r).toMatchObject({ ok: false, field: "prompt_body" });
  });

  it("allows an empty-string background (help_ai seeds background = '')", () => {
    const r = validatePersonaPatch({ background: "" });
    expect(r).toEqual({ ok: true, patch: { background: "" } });
  });

  it("requires anti_instructions to be an array of strings", () => {
    expect(validatePersonaPatch({ anti_instructions: "no" })).toMatchObject({ ok: false, field: "anti_instructions" });
    expect(validatePersonaPatch({ anti_instructions: [1, 2] })).toMatchObject({ ok: false, field: "anti_instructions" });
    expect(validatePersonaPatch({ anti_instructions: ["a", "b"] })).toEqual({
      ok: true,
      patch: { anti_instructions: ["a", "b"] },
    });
  });

  it("allows null for a nullable field and rejects a non-string non-null", () => {
    expect(validatePersonaPatch({ specialty: null })).toEqual({ ok: true, patch: { specialty: null } });
    expect(validatePersonaPatch({ specialty: 5 })).toMatchObject({ ok: false, field: "specialty" });
  });
});

describe("personaDefaultPatch", () => {
  it("returns exactly the editable columns from a PersonaRecord (no slug/kind/version)", () => {
    const def = getPersonaDefault("marcus-cole");
    expect(def).toBeDefined();
    const patch = personaDefaultPatch(def!);
    expect(Object.keys(patch).sort()).toEqual([...PERSONA_EDITABLE_COLUMNS].sort());
    expect("slug" in patch).toBe(false);
    expect("kind" in patch).toBe(false);
    expect("version" in patch).toBe(false);
  });
});

describe("applyPersonaPatch", () => {
  it("returns { notFound } and attempts no write when the slug has no row", async () => {
    const { db, calls } = makeDb({ versionRow: null });
    const result = await applyPersonaPatch(db, "ghost", { tagline: "x" }, "admin-1");
    expect(result).toEqual({ notFound: true });
    expect(calls.update).toBe(0);
  });

  it("bumps version, stamps updated_by, and returns the new version on success", async () => {
    const { db, getLastUpdatePayload } = makeDb({ versionRow: { version: 7 }, updateRows: [{ slug: "marcus-cole" }] });
    const result = await applyPersonaPatch(db, "marcus-cole", { tagline: "x" }, "admin-1");
    expect(result).toEqual({ version: 8 });
    const payload = getLastUpdatePayload()!;
    expect(payload.version).toBe(8);
    expect(payload.updated_by).toBe("admin-1");
    expect(payload.tagline).toBe("x");
    expect(typeof payload.updated_at).toBe("string");
  });

  it("raises when the CAS matches zero rows (concurrent edit / stale version)", async () => {
    const { db } = makeDb({ versionRow: { version: 7 }, updateRows: [] });
    await expect(applyPersonaPatch(db, "marcus-cole", { tagline: "x" }, null)).rejects.toThrow();
  });
});

describe("applySafetyPatch", () => {
  it("throws when the singleton 'default' row is missing (seed invariant)", async () => {
    const { db } = makeDb({ versionRow: null });
    await expect(applySafetyPatch(db, "EDITABLE", "admin-1")).rejects.toThrow(/seed invariant/);
  });

  it("bumps version and returns the new version on success", async () => {
    const { db, getLastUpdatePayload } = makeDb({ versionRow: { version: 3 }, updateRows: [{ id: "default" }] });
    const result = await applySafetyPatch(db, "NEW SAFETY TEXT", "admin-1");
    expect(result).toEqual({ version: 4 });
    const payload = getLastUpdatePayload()!;
    expect(payload.version).toBe(4);
    expect(payload.editable_block).toBe("NEW SAFETY TEXT");
  });
});
