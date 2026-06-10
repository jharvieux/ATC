// §24.x — HMAC-signed anonymous session cookie.
// Cookie value is <uuid>.<hmac-sha256-hex> where the HMAC key is
// ANON_COOKIE_SECRET. Prevents clients from forging or swapping session IDs
// to bypass per-session rate limits or access another user's conversation history.

import { createHmac, randomUUID, timingSafeEqual } from "crypto";

export const ANON_SESSION_COOKIE = "atc-anon-session";

function sign(uuid: string): string {
  const secret = process.env.ANON_COOKIE_SECRET;
  if (!secret) throw new Error("ANON_COOKIE_SECRET is not set");
  return createHmac("sha256", secret).update(uuid).digest("hex");
}

export function signAnonSession(uuid: string): string {
  return `${uuid}.${sign(uuid)}`;
}

// Returns the UUID if the HMAC signature is valid, or null if the cookie is
// malformed, unsigned, or tampered with.
export function verifyAnonSession(value: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  // No "." means no signature — reject. The §24.x migration window that
  // grandfathered plain-UUID cookies is closed (#514).
  if (dot === -1) return null;
  const uuid = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(uuid);
  if (mac.length !== expected.length) return null;
  // #725: timingSafeEqual prevents timing attacks — the JS XOR loop is not
  // constant-time under V8 JIT optimisation.
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return uuid;
}

export function freshAnonSession(): { id: string; cookieValue: string } {
  const id = randomUUID();
  return { id, cookieValue: signAnonSession(id) };
}

export function buildAnonCookieHeader(cookieValue: string, maxAge = 60 * 60 * 24 * 30): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANON_SESSION_COOKIE}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`;
}
