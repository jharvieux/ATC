import { describe, it, expect, beforeEach, vi } from "vitest";
import { BoundedTtlCache } from "@/lib/cache/bounded-ttl-cache";

describe("BoundedTtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe("get / set / miss", () => {
    it("returns undefined on a miss (no prior set)", () => {
      const cache = new BoundedTtlCache<string, number>();
      expect(cache.get("key1")).toBeUndefined();
    });

    it("returns the value after set", () => {
      const cache = new BoundedTtlCache<string, number>();
      cache.set("key1", 42);
      expect(cache.get("key1")).toBe(42);
    });

    it("returns undefined after TTL expiry", () => {
      const cache = new BoundedTtlCache<string, number>({ defaultTtlMs: 1000 });
      cache.set("key1", 42);
      expect(cache.get("key1")).toBe(42);
      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("distinguishes miss from cached null", () => {
      const cache = new BoundedTtlCache<string, string | null>();
      cache.set("present-null", null);
      expect(cache.get("missing")).toBeUndefined();
      expect(cache.get("present-null")).toBeNull();
      expect(cache.get("present-null")).not.toBeUndefined();
    });

    it("distinguishes miss from cached falsy values (0, false, '')", () => {
      const cache = new BoundedTtlCache<string, number | boolean | string>();
      cache.set("zero", 0);
      cache.set("false", false);
      cache.set("empty-string", "");
      expect(cache.get("zero")).toBe(0);
      expect(cache.get("false")).toBe(false);
      expect(cache.get("empty-string")).toBe("");
      expect(cache.get("missing")).toBeUndefined();
    });
  });

  describe("TTL", () => {
    it("respects custom ttl per-call", () => {
      const cache = new BoundedTtlCache<string, number>({ defaultTtlMs: 1000 });
      cache.set("default-ttl", 1, undefined); // uses default 1000ms
      cache.set("short-ttl", 2, 100);
      cache.set("long-ttl", 3, 5000);

      vi.advanceTimersByTime(150);
      expect(cache.get("default-ttl")).toBe(1);
      expect(cache.get("short-ttl")).toBeUndefined();
      expect(cache.get("long-ttl")).toBe(3);

      vi.advanceTimersByTime(900);
      expect(cache.get("default-ttl")).toBeUndefined();
      expect(cache.get("long-ttl")).toBe(3);

      vi.advanceTimersByTime(4000);
      expect(cache.get("long-ttl")).toBeUndefined();
    });

    it("honors defaultTtlMs constructor option", () => {
      const cache = new BoundedTtlCache<string, number>({ defaultTtlMs: 5000 });
      cache.set("key1", 42);
      vi.advanceTimersByTime(4500);
      expect(cache.get("key1")).toBe(42);
      vi.advanceTimersByTime(600);
      expect(cache.get("key1")).toBeUndefined();
    });
  });

  describe("LRU eviction", () => {
    it("evicts the LRU entry when exceeding maxEntries", () => {
      const cache = new BoundedTtlCache<string, number>({ maxEntries: 3 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.get("a")).toBe(1); // refresh recency of a
      expect(cache.get("b")).toBe(2); // refresh recency of b
      // c is now oldest (least recently used)

      cache.set("d", 4); // exceeds maxEntries=3
      // c should be evicted (LRU)
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBeUndefined();
      expect(cache.get("d")).toBe(4);
    });

    it("tracks recency on get() — get() refreshes MRU position", () => {
      const cache = new BoundedTtlCache<string, number>({ maxEntries: 3 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      // insertion order: a, b, c (c is newest, a is oldest)

      cache.get("a"); // refresh a's recency
      // now order is: b (oldest), c, a (newest)

      cache.set("d", 4); // exceeds maxEntries=3, b is LRU
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined(); // b was evicted
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("respects custom maxEntries option", () => {
      const cache = new BoundedTtlCache<string, number>({ maxEntries: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3); // exceeds maxEntries=2
      expect(cache.get("a")).toBeUndefined(); // a evicted
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
    });

    it("uses maxEntries=1000 as default", () => {
      const cache = new BoundedTtlCache<number, string>();
      // Insert 1001 entries
      for (let i = 0; i < 1001; i++) {
        cache.set(i, `value-${i}`);
      }
      // Key 0 (oldest) should be evicted
      expect(cache.get(0)).toBeUndefined();
      // Key 1000 (newest) should be present
      expect(cache.get(1000)).toBe("value-1000");
    });
  });

  describe("delete", () => {
    it("deletes a key explicitly", () => {
      const cache = new BoundedTtlCache<string, number>();
      cache.set("key1", 42);
      expect(cache.get("key1")).toBe(42);
      cache.delete("key1");
      expect(cache.get("key1")).toBeUndefined();
    });

    it("deletes a non-existent key without error", () => {
      const cache = new BoundedTtlCache<string, number>();
      cache.delete("never-existed");
      expect(cache.get("never-existed")).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("clears all entries", () => {
      const cache = new BoundedTtlCache<string, number>();
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.get("a")).toBe(1);
      cache.clear();
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    });
  });

  describe("set overwrites", () => {
    it("set(key, new_value) replaces the old value and refreshes TTL+recency", () => {
      const cache = new BoundedTtlCache<string, number>({ defaultTtlMs: 1000 });
      cache.set("key1", 42);
      vi.advanceTimersByTime(500);
      cache.set("key1", 99); // overwrite with new TTL
      vi.advanceTimersByTime(600); // 1100ms total from first set, but only 600ms from second
      expect(cache.get("key1")).toBe(99); // should still be live (TTL reset on overwrite)
    });

    it("set(key, ...) refreshes LRU position when overwriting", () => {
      const cache = new BoundedTtlCache<string, number>({ maxEntries: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      // order: a (oldest), b (newest)
      cache.set("a", 99); // refresh a to be newest
      // order: b (oldest), a (newest)
      cache.set("c", 3); // exceeds max, b is LRU
      expect(cache.get("a")).toBe(99);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
    });
  });

  describe("interaction: TTL expiry + LRU eviction", () => {
    it("expired entries are lazily evicted on read, freeing space for new entries", () => {
      const cache = new BoundedTtlCache<string, number>({
        maxEntries: 2,
        defaultTtlMs: 1000,
      });
      cache.set("a", 1);
      cache.set("b", 2); // cache is at capacity
      vi.advanceTimersByTime(1001); // expire both
      // Now when we insert a new entry, the expired one is found and deleted
      cache.set("c", 3);
      // The get() call on expired "a" will not evict it via get,
      // but set() for "c" will hit the size check and evict LRU (expired "a" is still counted)
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
    });
  });
});
