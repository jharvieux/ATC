// #1605 — one bounded, TTL-based in-process cache, replacing five hand-rolled
// module-level expiring-Map caches (resolve-tenant, vendor-health/registry,
// abuse/snapshot, persona-repository, rag/entity-extraction). Same best-effort,
// per-instance semantics as before (a cold instance misses and re-fetches) —
// the only behavioral change is an LRU entry-count bound, so a long-lived
// Fluid Compute instance can't leak memory via unbounded key growth.

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface BoundedTtlCacheOptions {
  /** Max entries before the least-recently-used one is evicted. Default 1000. */
  maxEntries?: number;
  /** Default TTL in ms for entries set without an explicit ttl. Default 5 min. */
  defaultTtlMs?: number;
}

export class BoundedTtlCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options: BoundedTtlCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60_000;
  }

  /** Returns undefined on miss or expiry; distinguishable from a cached `null`/falsy value. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to mark most-recently-used (Map iteration order is insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
    if (this.map.size > this.maxEntries) {
      const lruKey = this.map.keys().next().value as K;
      this.map.delete(lruKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
