// §18.5 — HMAC-signed invitation token, consolidated onto jose (#1604).
//
// New tokens: jose HS256 compact JWS with `aud: "invitation"` carrying the
// invitation_id as a claim, so the handler still gets the id from one decode
// without a DB round-trip.
//
// Legacy tokens (`${invitation_id}.${base64url(hmac)}`) verify indefinitely:
// validity is governed entirely by the DB's `token_revoked_at` /
// natural-expiry sweep (§18.9), not by anything encoded in the token itself,
// so there is no cutoff date that's safe to stop accepting the old format.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isCompactJws, signHmacJwt, verifyHmacJwt } from "@/lib/auth/hmac-jwt";

const PURPOSE = "invitation";

function keyBytes(key: string): Uint8Array {
  return Buffer.from(key, "base64");
}

function legacyComputeHmac(key: string, invitation_id: string): Buffer {
  return createHmac("sha256", keyBytes(key)).update(invitation_id).digest();
}

function legacyVerify(token: string, key: string): { invitation_id: string; ok: boolean } {
  const dot = token.indexOf(".");
  if (dot === -1) return { invitation_id: "", ok: false };
  const invitation_id = token.slice(0, dot);
  const providedHmac = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = legacyComputeHmac(key, invitation_id);
  if (providedHmac.length !== expected.length) return { invitation_id, ok: false };
  return { invitation_id, ok: timingSafeEqual(providedHmac, expected) };
}

function requireKey(): string {
  const key = process.env.INVITATION_TOKEN_HMAC_KEY;
  if (!key) throw new Error("INVITATION_TOKEN_HMAC_KEY not configured");
  return key;
}

export async function generateToken(invitation_id: string): Promise<string> {
  const key = requireKey();
  return signHmacJwt({ invitation_id }, keyBytes(key), PURPOSE);
}

export async function parseAndVerifyHmac(token: string): Promise<{ invitation_id: string; ok: boolean }> {
  const key = requireKey();
  if (!isCompactJws(token)) return legacyVerify(token, key);

  const decoded = await verifyHmacJwt<{ invitation_id: string }>(token, keyBytes(key), PURPOSE);
  if (!decoded || typeof decoded.invitation_id !== "string") return { invitation_id: "", ok: false };
  return { invitation_id: decoded.invitation_id, ok: true };
}
