// §23.3 — Tokens for unsubscribe links and companion pages, consolidated
// onto jose HS256 compact JWS (#1604).
//
// Token payload: { email, tenant_id, category }       for unsubscribe.
//                { booking_id, phase, exp? }          for companion pages.
//
// Key derivation: uses INVITATION_TOKEN_HMAC_KEY (same key as group invitations)
// with a purpose prefix to scope tokens. Companion pages use COMPANION_TOKEN_HMAC_KEY
// when set, falling back to INVITATION_TOKEN_HMAC_KEY. See MEMORY D-056.
//
// Legacy (pre-jose) tokens verify indefinitely — see legacyVerify(). Companion
// links live for 90 days and unsubscribe links sit in already-sent emails with
// no separate revocation, so there is no cutoff date that's safe to pick;
// legacy verification stays until the old format is naturally unreachable.

import { createHmac, timingSafeEqual } from "crypto";
import { isCompactJws, signHmacJwt, verifyHmacJwt } from "@/lib/auth/hmac-jwt";

const LEGACY_TOKEN_VERSION = 1;

type Versioned = { v?: number };
type UnsubscribePayload = { email: string; tenant_id: string; category: string };
type CompanionPayload = { booking_id: string; phase: string; exp?: number };

// Default companion-token lifetime: 90 days from sign time. Most cruises
// reference T-30/T-7/T+7 phases relative to sailing; 90d covers the
// entire relevant window and lets a customer revisit a couple of months
// post-trip if they want to.
const COMPANION_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

function hmacKeyString(purpose: "unsubscribe" | "companion"): string {
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

function hmacKeyBytes(purpose: "unsubscribe" | "companion"): Uint8Array {
  return new TextEncoder().encode(hmacKeyString(purpose));
}

// Old JSON+HMAC+base64url envelope. Kept verify-only — nothing signs this
// format anymore.
function legacyVerify<T extends Versioned>(token: string, purpose: "unsubscribe" | "companion"): T | null {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      payload: string;
      mac: string;
    };
    const key = hmacKeyString(purpose);
    const expected = createHmac("sha256", key).update(`${purpose}:${raw.payload}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(raw.mac, "hex");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return null;
    }
    const decoded = JSON.parse(raw.payload) as T;
    // Missing `v` predates the version field and is accepted for backward
    // compat; only an unknown *future* version is rejected.
    if (decoded.v !== undefined && decoded.v !== LEGACY_TOKEN_VERSION) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

async function sign(payload: Record<string, unknown>, purpose: "unsubscribe" | "companion", exp?: number): Promise<string> {
  return signHmacJwt(payload, hmacKeyBytes(purpose), purpose, exp);
}

async function verify<T extends Record<string, unknown> & Versioned>(
  token: string,
  purpose: "unsubscribe" | "companion",
): Promise<T | null> {
  if (!isCompactJws(token)) return legacyVerify<T>(token, purpose);
  return verifyHmacJwt<T>(token, hmacKeyBytes(purpose), purpose);
}

export async function signUnsubscribeToken(payload: UnsubscribePayload): Promise<string> {
  return sign(payload, "unsubscribe");
}

export async function verifyUnsubscribeToken(token: string): Promise<UnsubscribePayload | null> {
  return verify<UnsubscribePayload & Versioned>(token, "unsubscribe");
}

export async function signCompanionToken(payload: CompanionPayload): Promise<string> {
  const { exp, ...rest } = payload;
  const finalExp = exp ?? Math.floor(Date.now() / 1000) + COMPANION_TOKEN_TTL_SECONDS;
  return sign(rest, "companion", finalExp);
}

export async function verifyCompanionToken(token: string): Promise<CompanionPayload | null> {
  const decoded = await verify<CompanionPayload & Versioned>(token, "companion");
  if (!decoded) return null;
  // jose's jwtVerify already rejects expired new-format tokens; this catches
  // legacy-format tokens, which carry `exp` as a plain payload field jose
  // never sees.
  if (typeof decoded.exp === "number" && decoded.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return decoded;
}
