// §17.7 — post-login redirect-target validation.
//
// The OAuth round-trip carries a caller-supplied destination (the reauth page's
// `return` path, forwarded as ?next= through initiate → callback). It lands in
// a Location header, so it must be a same-app relative path or an attacker can
// turn login into an open redirect (//evil.com, https://evil.com, /\evil.com)
// or inject headers via CRLF. We also refuse auth/api internals so a stale
// value (the signup page's legacy /auth/callback?flow=) can't bounce the user
// into a 404 or a redirect loop. Anything rejected falls back to "/" at the
// call site.

export function isSafePostLoginPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (!path.startsWith("/")) return false; // must be relative to this origin
  if (path.startsWith("//") || path.startsWith("/\\")) return false; // protocol-relative
  if (/[\x00-\x1f\x7f]/.test(path)) return false; // reject CRLF / control chars
  if (path.startsWith("/auth/") || path === "/auth") return false; // no auth-internal bounce
  if (path.startsWith("/api/") || path === "/api") return false; // not a page
  return true;
}
