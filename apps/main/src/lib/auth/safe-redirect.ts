// §17.7 — post-login redirect-target validation.
//
// The OAuth round-trip carries a caller-supplied destination (the reauth
// page's `return` path, forwarded as ?next= through initiate → callback).
// It lands in a Location header, so we have to be sure it stays on our
// origin.
//
// Earlier shape (isSafePostLoginPath) was a startsWith-chain predicate
// that returned a boolean and let the raw user input flow into URL
// construction. Both OWASP (Unvalidated Redirects Cheat Sheet) and CodeQL
// (js/user-controlled-bypass-of-security-check) flag that shape because
// userinfo / fullwidth-slash / protocol-relative / encoded-slash tricks
// historically slip past string-shape checks. Current shape parses the
// input against our origin first and checks `parsed.origin` — the
// bypasses defeat themselves at parse time because the WHATWG URL parser
// normalizes the same way the browser does.
//
// Caller contract: pass the raw query value + the trusted origin; receive
// either a SafeNext (containing the normalized path+search+hash you can
// echo back) or null (treat as "redirect home").

export interface SafeNext {
  path: string;
}

const AUTH_INTERNAL_PREFIX = "/auth/";
const AUTH_INTERNAL_EXACT = "/auth";
const API_INTERNAL_PREFIX = "/api/";
const API_INTERNAL_EXACT = "/api";
const MAX_LENGTH = 512;
// Reject CRLF + control bytes pre-parse — defense-in-depth against
// header-injection if a Location header consumer ever skips encoding.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function safeNextFor(
  next: string | null | undefined,
  origin: string,
): SafeNext | null {
  if (typeof next !== "string") return null;
  if (next.length === 0 || next.length > MAX_LENGTH) return null;
  if (CONTROL_CHARS.test(next)) return null;

  let parsed: URL;
  try {
    parsed = new URL(next, origin);
  } catch {
    return null;
  }

  if (parsed.origin !== origin) return null;
  if (
    parsed.pathname.startsWith(AUTH_INTERNAL_PREFIX) ||
    parsed.pathname === AUTH_INTERNAL_EXACT
  ) {
    return null;
  }
  if (
    parsed.pathname.startsWith(API_INTERNAL_PREFIX) ||
    parsed.pathname === API_INTERNAL_EXACT
  ) {
    return null;
  }

  return { path: parsed.pathname + parsed.search + parsed.hash };
}
