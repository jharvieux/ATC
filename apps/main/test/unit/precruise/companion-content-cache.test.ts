// #1953 — companion-page cache wiring: a placeholder-phase render must
// never survive the content write. pre_cruise_email_content is written in
// phases (row exists → generated_content finalized later), so the cached
// companion read is only safe if the tag the WRITER invalidates is exactly
// the tag the READER registered. These tests run a behavioral fake of the
// Next data cache (memoize by key, purge by tag) to prove the round trip:
// cached placeholder → write + revalidateCompanionContent → fresh content.
// A tag-format drift between getCompanionContent and
// revalidateCompanionContent fails here — that drift is a permanently
// stale customer PII page in production.

import { describe, it, expect, vi, beforeEach } from "vitest";

type CacheEntry = { value: unknown; tags: string[] };

const fakeCache = vi.hoisted(() => ({
  store: new Map<string, CacheEntry>(),
}));

vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, keyParts: string[], opts?: { tags?: string[] }) =>
    async () => {
      const key = JSON.stringify(keyParts);
      const hit = fakeCache.store.get(key);
      if (hit) return hit.value;
      const value = await fn();
      fakeCache.store.set(key, { value, tags: opts?.tags ?? [] });
      return value;
    },
  revalidateTag: (tag: string) => {
    for (const [key, entry] of fakeCache.store) {
      if (entry.tags.includes(tag)) fakeCache.store.delete(key);
    }
  },
}));

const db = vi.hoisted(() => ({
  // (booking_id, phase) → generated_content row, mutable per test.
  rows: new Map<string, Record<string, unknown> | null>(),
  reads: 0,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const filters: Record<string, string> = {};
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: (col: string, val: string) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        db.reads++;
        const content = db.rows.get(`${filters.booking_id}:${filters.email_phase}`) ?? null;
        return { data: content ? { generated_content: content } : null, error: null };
      },
    };
    return chain;
  },
}));

import {
  getCompanionContent,
  revalidateCompanionContent,
  companionContentTag,
} from "@/lib/precruise/companion-content";

beforeEach(() => {
  fakeCache.store.clear();
  db.rows.clear();
  db.reads = 0;
});

describe("companion content cache (#1953)", () => {
  it("placeholder-phase content is never served after the content write lands", async () => {
    db.rows.set("b1:t_7", { packing_checklist: [] }); // placeholder-ish partial row

    const first = await getCompanionContent("b1", "t_7");
    expect(first?.generated_content).toEqual({ packing_checklist: [] });

    // Content lands in the DB — but WITHOUT invalidation the cache still
    // pins the placeholder (this is the hazard #1953 describes).
    db.rows.set("b1:t_7", { packing_checklist: ["sunscreen"], embarkation_advice: "Arrive early." });
    const stale = await getCompanionContent("b1", "t_7");
    expect(stale?.generated_content).toEqual({ packing_checklist: [] });

    // The write path's revalidate purges the entry; the next render reads fresh.
    revalidateCompanionContent("b1", "t_7");
    const fresh = await getCompanionContent("b1", "t_7");
    expect(fresh?.generated_content).toEqual({
      packing_checklist: ["sunscreen"],
      embarkation_advice: "Arrive early.",
    });
  });

  it("a cached 'no row yet' result is purged when the first content insert revalidates", async () => {
    expect(await getCompanionContent("b2", "t_30")).toBeNull();

    db.rows.set("b2:t_30", { checkin_window: "Opens at T-21." });
    // Still null until the insert path revalidates — then fresh.
    expect(await getCompanionContent("b2", "t_30")).toBeNull();
    revalidateCompanionContent("b2", "t_30");
    expect((await getCompanionContent("b2", "t_30"))?.generated_content).toEqual({
      checkin_window: "Opens at T-21.",
    });
  });

  it("revalidating one booking+phase does not purge an unrelated entry (key independence)", async () => {
    db.rows.set("b1:t_7", { a: 1 });
    db.rows.set("b9:t_7", { b: 2 });
    await getCompanionContent("b1", "t_7");
    await getCompanionContent("b9", "t_7");
    const readsAfterWarm = db.reads;

    revalidateCompanionContent("b1", "t_7");
    await getCompanionContent("b9", "t_7"); // still cached — no new DB read
    expect(db.reads).toBe(readsAfterWarm);
    await getCompanionContent("b1", "t_7"); // purged — re-reads
    expect(db.reads).toBe(readsAfterWarm + 1);
  });

  it("tag format is a pure function of (booking_id, phase) — reader and writer share it", () => {
    expect(companionContentTag("b1", "t_7")).toBe(companionContentTag("b1", "t_7"));
    expect(companionContentTag("b1", "t_7")).not.toBe(companionContentTag("b1", "t_30"));
    expect(companionContentTag("b1", "t_7")).not.toBe(companionContentTag("b2", "t_7"));
  });
});
