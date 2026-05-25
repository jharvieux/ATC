// §23.3 — HMAC-signed tokens for unsubscribe links and companion pages.
//
// Token payload: { email, tenant_id, category }       for unsubscribe.
//                { booking_id, phase, exp? }          for companion pages.
//
// Key derivation: uses INVITATION_TOKEN_HMAC_KEY (same key as group invitations)
// with a purpose prefix to scope tokens. Companion pages use COMPANION_TOKEN_HMAC_KEY
// when set, falling back to INVITATION_TOKEN_HMAC_KEY. See MEMORY D-056.
//
// 2026-05-25 audit pass 2 hardenings:
//   - Finding 3 (Med): the prior `?? ""` fallback in hmacKey() meant a
//     deployment with a missing env var silently signed tokens with an
//     empty key — an attacker who noticed could forge tokens. Now throws.
//   - Finding 2 (Med): companion tokens had no expiration. A leaked link
//     was viewable for the life of the platform. Now carries `exp` (90d
//     by default) and verify rejects past-expiry tokens.

import { createHmac, timingSafeEqual } from "crypto";

type UnsubscribePayload = { email: string; tenant_id: string; category: string };
type CompanionPayload = { booking_id: string; phase: string; exp?: number };

// Default companion-token lifetime: 90 days from sign time. Most cruises
// reference T-30/T-7/T+7 phases relative to sailing; 90d covers the
// entire relevant window and lets a customer revisit a couple of months
// post-trip if they want to.
const COMPANION_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

function hmacKey(purpose: "unsubscribe" | "companion"): string {
  const candidate =
    purpose === "companion"
      ? process.env.COMPANION_TOKEN_HMAC_KEY ?? process.env.INVITATION_TOKEN_HMAC_KEY
      : process.env.INVITATION_TOKEN_HMAC_KEY;
  if (!candidate) {
    throw new Error(
      `Missing HMAC key for token purpose '${purpose}'. ` +
        `Set INVITATION_TOKEN_HMAC_KEY (and optionally COMPANION_TOKEN_HMAC_KEY) ` +
        `in the deployment environment.`,
    );
  }
  return candidate;
}

function sign(payload: object, purpose: "unsubscribe" | "companion"): string {
  const key = hmacKey(purpose);
  const data = JSON.stringify(payload);
  const mac = createHmac("sha256", key).update(`${purpose}:${data}`).digest("hex");
  const token = Buffer.from(JSON.stringify({ payload: data, mac })).toString("base64url");
  return token;
}

function verify<T>(token: string, purpose: "unsubscribe" | "companion"): T | null {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      payload: string;
      mac: string;
    };
    const key = hmacKey(purpose);
    const expected = createHmac("sha256", key).update(`${purpose}:${raw.payload}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(raw.mac, "hex");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return null;
    }
    return JSON.parse(raw.payload) as T;
  } catch {
    return null;
  }
}

export function signUnsubscribeToken(payload: UnsubscribePayload): string {
  return sign(payload, "unsubscribe");
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  return verify<UnsubscribePayload>(token, "unsubscribe");
}

export function signCompanionToken(payload: CompanionPayload): string {
  // Always stamp an exp if the caller didn't provide one. Existing callers
  // pass { booking_id, phase } and get a 90d window automatically.
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + COMPANION_TOKEN_TTL_SECONDS;
  return sign({ ...payload, exp }, "companion");
}

export function verifyCompanionToken(token: string): CompanionPayload | null {
  const decoded = verify<CompanionPayload>(token, "companion");
  if (!decoded) return null;
  // Reject expired tokens. Tokens issued before this fix don't have `exp`;
  // treat them as still valid for backward compat (they'll naturally roll
  // off as new tokens replace them).
  if (typeof decoded.exp === "number" && decoded.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return decoded;
}
