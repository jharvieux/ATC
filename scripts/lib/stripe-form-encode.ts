// Stripe expects `application/x-www-form-urlencoded` bodies with bracketed
// keys for nested objects and zero-indexed brackets for arrays.
//
//   { customer: "cus_X", items: [{ price: "p_X" }] }
//   →  customer=cus_X&items[0][price]=p_X
//
//   { metadata: { tenant_id: "t1" } }
//   →  metadata[tenant_id]=t1
//
// Used by the contracts-canary recorder so we can replay fixture request
// bodies (stored as JSON for readability) against Stripe's wire format.

function flatten(prefix: string, value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(`${prefix}[${i}]`, item, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      flatten(prefix ? `${prefix}[${k}]` : k, v, out);
    }
    return;
  }
  out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
}

export function stripeFormEncode(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    flatten(k, v, parts);
  }
  return parts.join("&");
}
