// §24.x — HMAC-signed anonymous session cookie, consolidated onto jose (#1604).
// New cookie value is a jose HS256 compact JWS (`aud: "anon-session"`)
// carrying `{ sid: uuid }`. Legacy `<uuid>.<hmac-sha256-hex>` cookies verify
// indefinitely — the 30-day cookie Max-Age means old-format cookies roll off
// naturally within a month of deploy, but there's no reason to reject them
// early and force every anon visitor's session to reset.

import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { isCompactJws, signHmacJwt, verifyHmacJwt } from "@/lib/auth/hmac-jwt";

export const ANON_SESSION_COOKIE = "atc-anon-session";
const PURPOSE = "anon-session";

function requireSecret(): string {
  const secret = process.env.ANON_COOKIE_SECRET;
  if (!secret) throw new Error("ANON_COOKIE_SECRET is not set");
  return secret;
}

function legacySign(uuid: string): string {
  return createHmac("sha256", requireSecret()).update(uuid).digest("hex");
}

export async function signAnonSession(uuid: string): Promise<string> {
  const key = new TextEncoder().encode(requireSecret());
  return signHmacJwt({ sid: uuid }, key, PURPOSE);
}

// Returns the UUID if the signature is valid, or null if the cookie is
// malformed, unsigned, or tampered with.
export async function verifyAnonSession(value: string): Promise<string | null> {
  if (!value) return null;

  if (!isCompactJws(value)) {
    // Legacy <uuid>.<hex-mac>. No "." means no signature — reject. The §24.x
    // migration window that grandfathered plain-UUID cookies is closed (#514).
    const dot = value.lastIndexOf(".");
    if (dot === -1) return null;
    const uuid = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    const expected = legacySign(uuid);
    if (mac.length !== expected.length) return null;
    // #725: timingSafeEqual prevents timing attacks — the JS XOR loop is not
    // constant-time under V8 JIT optimisation.
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    return uuid;
  }

  const key = new TextEncoder().encode(requireSecret());
  const decoded = await verifyHmacJwt<{ sid: string }>(value, key, PURPOSE);
  if (!decoded || typeof decoded.sid !== "string") return null;
  return decoded.sid;
}

export async function freshAnonSession(): Promise<{ id: string; cookieValue: string }> {
  const id = randomUUID();
  return { id, cookieValue: await signAnonSession(id) };
}

export function buildAnonCookieHeader(cookieValue: string, maxAge = 60 * 60 * 24 * 30): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANON_SESSION_COOKIE}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`;
}
