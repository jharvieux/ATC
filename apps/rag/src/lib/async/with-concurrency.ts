// #1787 — Bounded-concurrency map. Runs `fn` over `items` with at most
// `limit` in flight at once, preserving result order. Use where unbounded
// Promise.all would fan out too aggressively against a downstream service
// but full serialization is the N+1 latency problem being fixed.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // limit <= 0 would spawn zero workers and silently return a hole-filled
  // array — fail loud instead (all current callers pass literals, but a
  // config-derived limit could hit this).
  if (limit <= 0) throw new Error("mapWithConcurrency: limit must be >= 1");
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      // Safe: i was just bounds-checked against items.length above.
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
