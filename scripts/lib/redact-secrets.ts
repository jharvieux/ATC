// #1784 — operator scripts print raw caught errors on crash
// (`main().catch((err) => console.error(..., err))`). Several of them connect
// via a `postgres://user:pass@host` URL (SUPABASE_DB_URL) or send a Bearer
// token (SUPABASE_ACCESS_TOKEN); if the underlying error ever stringifies the
// connection string or an Authorization header — e.g. a malformed-URL parse
// failure — the credential lands verbatim in CI logs. Scrub before logging.
//
// NON-GOAL: bare tokens outside a `Bearer ` header or connection-string URL
// (e.g. a raw `token=sbp_x` query param or standalone API key in a message)
// are not redacted. Catching arbitrary secret-shaped substrings risks
// clobbering legitimate error text; the known leak vectors here are the two
// patterns below. Don't read a bare-token miss as a bug — it's scope.
//
// NON-GOAL: a literal unencoded `@` inside a password leaves the post-@
// fragment unredacted (`postgres://user:pa@ss@host` → `[redacted]@ss@host`).
// A greedy match here would break multi-credential redaction (the `/g` pin
// on CONN_STRING_CREDENTIALS), so the current regex is correct; passwords
// should be URL-encoded anyway. Accepted gap, not a bug (#1814).
//
// VERIFIED (#1837, against postgres@3.4.9 with node_modules installed):
// postgres.js's PostgresError (server-side error responses) and
// Errors.connection() (client-side connect/timeout/close errors) never
// attach the raw connection string as an own-enumerable property — the
// premise that they might was disproven by reading node_modules/postgres/
// src/{errors,index}.js. The one real leak path is Node's own `new URL()`:
// postgres.js's parseUrl() calls it on the connection string, and on a
// malformed URL (e.g. `postgres://user:pass@` with an empty host) Node
// throws a TypeError whose `.message`/`.stack` say only "Invalid URL" but
// whose `.input` own-property holds the raw string, credential included.
// A bare `console.error(err)` (util.inspect's default Error formatting)
// prints `.input` alongside the stack — that's the exact shape #1784/#1814
// scrub by routing through redactSecrets() instead. redactSecrets() itself
// is unaffected: it reads only `.stack ?? .message`, so `.input` is never
// consumed and the credential never reaches its output. Confirmed live
// (`postgres("postgres://dbuser:s3cr3tpass@")` throws with `.input` set,
// `.stack` reads "TypeError: Invalid URL" with no credential); see the
// "Node URL parser: .input leaks a malformed connection string" test in
// tests/unit/scripts/redact-secrets.test.ts for the pinned regression.
const CONN_STRING_CREDENTIALS = /(:\/\/)[^:@/\s]*:[^@/\s]+@/g;
const BEARER_TOKEN = /Bearer\s+\S+/gi;

export function redactSecrets(input: unknown): string {
  // Redact the stack (not the raw Error object) so frames survive: the stack
  // string embeds the message, and PostgresError-style errors that carry a
  // raw connection string on a separate `.input` property never reach here —
  // only message/stack text does.
  const text = input instanceof Error ? (input.stack ?? input.message) : String(input);
  return text.replace(CONN_STRING_CREDENTIALS, "$1[redacted]@").replace(BEARER_TOKEN, "Bearer [redacted]");
}
