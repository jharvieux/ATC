// §24.x — HMAC-signed anonymous session cookie.
// Cookie value is <uuid>.<hmac-sha256-hex> where the HMAC key is
// ANON_COOKIE_SECRET. Prevents clients from forging or swapping session IDs
// to bypass per-session rate limits or access another user's conversation history.
//
// Migration window: plain UUID cookies (no ".") are accepted and re-issued as
// signed so in-flight sessions survive the deploy without losing history.
// After one full release cycle, the unsigned fallback can be removed.

import { createHmac, randomUUID } from "crypto";

export const ANON_SESSION_COOKIE = "atc-anon-session";

function sign(uuid: string): string {
  const secret = process.env.ANON_COOKIE_SECRET ?? "";
  return createHmac("sha256", secret).update(uuid).digest("hex");
}

export function signAnonSession(uuid: string): string {
  return `${uuid}.${sign(uuid)}`;
}

// Returns the UUID if the signature is valid, the UUID if it's a legacy
// unsigned cookie (migration window), or null if malformed/tampered.
export function verifyAnonSession(value: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot === -1) {
    // Legacy unsigned cookie — accept during migration, re-issue as signed.
    return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  }
  const uuid = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(uuid);
  if (mac.length !== expected.length) return null;
  // Constant-time comparison to prevent timing attacks.
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? uuid : null;
}

export function freshAnonSession(): { id: string; cookieValue: string } {
  const id = randomUUID();
  return { id, cookieValue: signAnonSession(id) };
}

export function buildAnonCookieHeader(cookieValue: string, maxAge = 60 * 60 * 24 * 30): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANON_SESSION_COOKIE}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`;
}
