// §25.5 / §26.13 — Sentry PII scrubbing.
//
// Used by sentry.client.config.ts and sentry.server.config.ts in the
// beforeSend hook. Recursively walks the event JSON and:
//   • Redacts any field whose key is in PII_FIELD_NAMES (case-insensitive).
//   • Strips URL query params named in PII_QUERY_PARAMS from event.request.url
//     and breadcrumb URLs.
//   • Drops the `cookies` header from event.request.headers.
//   • Drops event.request.data (request body) unconditionally — operators
//     opt-in per handler by calling Sentry.setExtra after manual redaction.
//
// Exported standalone so it can be unit-tested without the Sentry SDK.

const PII_FIELD_NAMES = new Set([
  "email",
  "phone",
  "dob",
  "date_of_birth",
  "passport_number",
  "passport_number_encrypted",
  "legal_first_name",
  "legal_last_name",
  "ssn",
  "tax_id",
  "credit_card",
]);

const PII_QUERY_PARAMS = new Set(["email", "token", "code", "key", "signature"]);

const REDACTED = "[redacted]";

export function scrubPii<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => walk(v));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELD_NAMES.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    if (key === "url" && typeof v === "string") {
      out[key] = stripQueryParams(v);
      continue;
    }
    if (key === "headers" && v && typeof v === "object" && !Array.isArray(v)) {
      const headers: Record<string, unknown> = {};
      for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
        if (hk.toLowerCase() === "cookie" || hk.toLowerCase() === "cookies") continue;
        headers[hk] = hv;
      }
      out[key] = headers;
      continue;
    }
    if (key === "data" && (value as Record<string, unknown>).method) {
      // event.request.data — body. Drop entirely.
      continue;
    }
    out[key] = walk(v);
  }
  return out;
}

export function stripQueryParams(url: string): string {
  try {
    const u = new URL(url, "https://placeholder.invalid");
    for (const param of [...u.searchParams.keys()]) {
      if (PII_QUERY_PARAMS.has(param.toLowerCase())) {
        u.searchParams.set(param, REDACTED);
      }
    }
    // Reconstruct in the original form if it was relative.
    if (url.startsWith("/")) {
      return u.pathname + u.search + u.hash;
    }
    return u.toString();
  } catch {
    return url;
  }
}
