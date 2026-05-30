// Replace placeholder Stripe IDs inside a request body with the real IDs
// captured earlier in the recording session.
//
// Fixtures use stable placeholders like "cus_test_placeholder" so they
// stay valid in MSW replay mode (the PR-track contract tests don't hit
// real Stripe). When the canary replays the request against real Stripe,
// we substitute each placeholder with the ID Stripe just returned.
//
// Walks the body recursively; arrays and nested objects are traversed.
// Non-string scalars pass through untouched.

export type Substitutions = Record<string, string>;

export function substitutePlaceholders<T>(value: T, subs: Substitutions): T {
  if (typeof value === "string") {
    return (subs[value] ?? value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, subs)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitutePlaceholders(v, subs);
    }
    return out as T;
  }
  return value;
}
