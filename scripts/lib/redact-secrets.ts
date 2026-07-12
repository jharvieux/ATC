// #1784 — operator scripts print raw caught errors on crash
// (`main().catch((err) => console.error(..., err))`). Several of them connect
// via a `postgres://user:pass@host` URL (SUPABASE_DB_URL) or send a Bearer
// token (SUPABASE_ACCESS_TOKEN); if the underlying error ever stringifies the
// connection string or an Authorization header — e.g. a malformed-URL parse
// failure — the credential lands verbatim in CI logs. Scrub before logging.

const CONN_STRING_CREDENTIALS = /(:\/\/)[^:@/\s]+:[^@/\s]+@/g;
const BEARER_TOKEN = /Bearer\s+\S+/gi;

export function redactSecrets(input: unknown): string {
  const text = input instanceof Error ? input.message : String(input);
  return text.replace(CONN_STRING_CREDENTIALS, "$1[redacted]@").replace(BEARER_TOKEN, "Bearer [redacted]");
}
