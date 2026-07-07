// §24.5 — loadUnionSlurDenyList fail-closed behaviour and list-union logic.
//
// Pins that a DB error on either the platform settings read or the tenant
// supplemental read throws (not silently returns an empty list), so the
// supervisor fails loudly rather than passing content through without
// checking the deny list.

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUnionSlurDenyList } from "@/lib/supervisor/load-deny-list";
import { _resetPlatformSettingCacheForTests } from "@/lib/platform/platform-setting-cache";

// #1586 — the platform slur list is now served from a shared 60s cache. Reset
// it between specs so each test's mock data (not a prior test's cached value)
// drives the result.
beforeEach(() => {
  _resetPlatformSettingCacheForTests();
});

type FakeRow = Record<string, unknown> | null;

function makeDb(opts: {
  platformData?: FakeRow;
  platformError?: { message: string } | null;
  tenantData?: FakeRow;
  tenantError?: { message: string } | null;
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.platformData ?? null,
                error: opts.platformError ?? null,
              }),
            }),
          }),
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      if (table === "tenant_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.tenantData ?? null,
                error: opts.tenantError ?? null,
              }),
            }),
          }),
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      throw new Error("unexpected table: " + table);
    },
  } as unknown as SupabaseClient;
}

describe("loadUnionSlurDenyList", () => {
  it("returns union of platform + tenant lists, deduped case-insensitively", async () => {
    const db = makeDb({
      platformData: { value: ["Slur1", "slur2"] },
      tenantData: { supplemental_hate_speech_denylist: ["SLUR2", "slur3"] },
    });
    const list = await loadUnionSlurDenyList(db, "tenant-1");
    expect(list).toContain("Slur1");
    expect(list).toContain("slur2");
    expect(list).toContain("slur3");
    // slur2/SLUR2 deduplicated
    expect(list.filter((t) => t.toLowerCase() === "slur2")).toHaveLength(1);
  });

  it("returns platform list alone when tenant has no supplemental", async () => {
    const db = makeDb({
      platformData: { value: ["badword"] },
      tenantData: null,
    });
    const list = await loadUnionSlurDenyList(db, "tenant-1");
    expect(list).toEqual(["badword"]);
  });

  it("returns empty list when platform setting is not configured (null data, no error)", async () => {
    const db = makeDb({ platformData: null, tenantData: null });
    const list = await loadUnionSlurDenyList(db, "tenant-1");
    expect(list).toEqual([]);
  });

  it("fail-closed: throws when platform_settings SELECT errors (not silently returns empty)", async () => {
    const db = makeDb({
      platformError: { message: "DB connection refused" },
    });
    await expect(loadUnionSlurDenyList(db, "tenant-1")).rejects.toThrow(
      /supervisor_slur_deny_list\.read failed/,
    );
  });

  it("fail-closed: throws when tenant_settings SELECT errors (not silently returns empty)", async () => {
    const db = makeDb({
      platformData: { value: ["safe-word"] },
      tenantError: { message: "RLS timeout" },
    });
    await expect(loadUnionSlurDenyList(db, "tenant-1")).rejects.toThrow(
      /supplemental_hate_speech_denylist\.read failed/,
    );
  });
});
