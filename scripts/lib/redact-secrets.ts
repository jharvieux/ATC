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
