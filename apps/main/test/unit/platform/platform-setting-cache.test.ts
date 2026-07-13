// #1586 — platform_settings TTL cache.
//
// WHY these matter: the chat hot path relies on this cache to collapse 3-4
// per-message platform_settings reads to (near) zero DB round-trips. The
// invariants that make that safe are (1) a hit never touches the DB, (2) a
// read ERROR is surfaced to the caller AND not cached (so a caller that fails
// closed still fails closed, and the next call retries), and (3) a value is
// served for the full TTL.

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCachedPlatformSetting,
  _resetPlatformSettingCacheForTests,
  evictPlatformSetting,
  resolveHostAgencyLegalName,
} from "@/lib/platform/platform-setting-cache";

type Result = { data: unknown; error: { message: string } | null };

function makeDb(result: Result, dbReads: { count: number }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            dbReads.count += 1;
            return result;
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  _resetPlatformSettingCacheForTests();
});

describe("getCachedPlatformSetting", () => {
  it("returns the value and hits the DB on a cold miss", async () => {
    const reads = { count: 0 };
    const db = makeDb({ data: { value: ["a", "b"] }, error: null }, reads);
    const { value, error } = await getCachedPlatformSetting(db, "k1");
    expect(error).toBeNull();
    expect(value).toEqual(["a", "b"]);
    expect(reads.count).toBe(1);
  });

  it("serves a second read from cache WITHOUT a DB round-trip", async () => {
    const reads = { count: 0 };
    const db = makeDb({ data: { value: 42 }, error: null }, reads);
    await getCachedPlatformSetting(db, "k1");
    const { value } = await getCachedPlatformSetting(db, "k1");
    expect(value).toBe(42);
    expect(reads.count).toBe(1); // still 1 — the second call was a cache hit
  });

  it("fires onDbRead only on the cold miss, never on the hit", async () => {
    const reads = { count: 0 };
    const db = makeDb({ data: { value: 1 }, error: null }, reads);
    let cbFires = 0;
    await getCachedPlatformSetting(db, "k1", () => { cbFires += 1; });
    await getCachedPlatformSetting(db, "k1", () => { cbFires += 1; });
    expect(cbFires).toBe(1);
  });

  it("surfaces the error AND does not cache it — the next call retries", async () => {
    const reads = { count: 0 };
    const errDb = makeDb({ data: null, error: { message: "boom" } }, reads);
    const first = await getCachedPlatformSetting(errDb, "k1");
    expect(first.error).not.toBeNull();
    expect(first.value).toBeNull();

    // Same key, now succeeding — must NOT return a cached error/null.
    const okDb = makeDb({ data: { value: "recovered" }, error: null }, { count: 0 });
    const second = await getCachedPlatformSetting(okDb, "k1");
    expect(second.error).toBeNull();
    expect(second.value).toBe("recovered");
  });

  it("null value (unconfigured key) is cached as null", async () => {
    const reads = { count: 0 };
    const db = makeDb({ data: null, error: null }, reads);
    const first = await getCachedPlatformSetting(db, "k1");
    expect(first.value).toBeNull();
    const second = await getCachedPlatformSetting(db, "k1");
    expect(second.value).toBeNull();
    expect(reads.count).toBe(1); // null-but-no-error IS cached
  });

  it("evictPlatformSetting forces the next read back to the DB", async () => {
    const reads = { count: 0 };
    const db = makeDb({ data: { value: "v" }, error: null }, reads);
    await getCachedPlatformSetting(db, "k1");
    evictPlatformSetting("k1");
    await getCachedPlatformSetting(db, "k1");
    expect(reads.count).toBe(2);
  });
});

// §20.7 / #1877 — the single canonical host_agency_legal_name unwrap. WHY it
// matters: this feeds a customer-facing LEGAL disclosure. It must tolerate both
// wire shapes (bare string, {value:string}) yet fail closed to null on anything
// malformed so callers never render a fabricated legal name. Before #1877 the
// unwrap was copy-pasted four ways (one of which mangled the object shape to
// "[object Object]"); these pin the one behavior everyone now shares.
describe("resolveHostAgencyLegalName", () => {
  it("returns a bare string value verbatim", () => {
    expect(resolveHostAgencyLegalName("Wavecrest Host Agency LLC")).toBe(
      "Wavecrest Host Agency LLC",
    );
  });

  it("unwraps the legacy {value: string} object shape", () => {
    expect(resolveHostAgencyLegalName({ value: "Nested Host LLC" })).toBe("Nested Host LLC");
  });

  it("fails closed to null on a missing value (null/undefined)", () => {
    expect(resolveHostAgencyLegalName(null)).toBeNull();
    expect(resolveHostAgencyLegalName(undefined)).toBeNull();
  });

  it("fails closed to null on a malformed object (no string .value)", () => {
    expect(resolveHostAgencyLegalName({})).toBeNull();
    expect(resolveHostAgencyLegalName({ value: 42 })).toBeNull();
    expect(resolveHostAgencyLegalName({ value: { deep: "x" } })).toBeNull();
  });

  it("never returns the fabricated 'Host Agency' placeholder for malformed input", () => {
    expect(resolveHostAgencyLegalName({})).not.toBe("Host Agency");
    expect(resolveHostAgencyLegalName(null)).not.toBe("Host Agency");
  });
});
