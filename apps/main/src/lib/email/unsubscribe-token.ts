// §23.3 — HMAC-signed tokens for unsubscribe links and companion pages.
//
// Token payload: { email, tenant_id, category } for unsubscribe.
//                { booking_id, phase }           for companion pages.
//
// Key derivation: uses INVITATION_TOKEN_HMAC_KEY (same key as group invitations)
// with a purpose prefix to scope tokens. Companion pages use COMPANION_TOKEN_HMAC_KEY
// when set, falling back to INVITATION_TOKEN_HMAC_KEY. See MEMORY D-056.

import { createHmac, timingSafeEqual } from "crypto";

type UnsubscribePayload = { email: string; tenant_id: string; category: string };
type CompanionPayload   = { booking_id: string; phase: string };

function hmacKey(purpose: "unsubscribe" | "companion"): string {
  if (purpose === "companion") {
    return process.env.COMPANION_TOKEN_HMAC_KEY ?? process.env.INVITATION_TOKEN_HMAC_KEY ?? "";
  }
  return process.env.INVITATION_TOKEN_HMAC_KEY ?? "";
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
  return sign(payload, "companion");
}

export function verifyCompanionToken(token: string): CompanionPayload | null {
  return verify<CompanionPayload>(token, "companion");
}
