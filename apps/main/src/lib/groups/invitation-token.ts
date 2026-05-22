// §18.5 — HMAC-signed invitation token.
//
// Token format: `${invitation_id}.${base64url(HMAC-SHA256(key, invitation_id))}`
// The invitation_id (UUID) is embedded so the handler can look it up in one
// DB round-trip; the HMAC binds it to platform-issued tokens. An attacker who
// knows a valid invitation_id cannot forge a token without the HMAC key.

import { createHmac, timingSafeEqual } from "node:crypto";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function computeHmac(key: string, invitation_id: string): Buffer {
  return createHmac("sha256", Buffer.from(key, "base64")).update(invitation_id).digest();
}

export function generateToken(invitation_id: string): string {
  const key = process.env.INVITATION_TOKEN_HMAC_KEY;
  if (!key) throw new Error("INVITATION_TOKEN_HMAC_KEY not configured");
  const hmac = computeHmac(key, invitation_id);
  return `${invitation_id}.${toBase64Url(hmac)}`;
}

export function parseAndVerifyHmac(token: string): { invitation_id: string; ok: boolean } {
  const key = process.env.INVITATION_TOKEN_HMAC_KEY;
  if (!key) throw new Error("INVITATION_TOKEN_HMAC_KEY not configured");
  const dot = token.indexOf(".");
  if (dot === -1) return { invitation_id: "", ok: false };
  const invitation_id = token.slice(0, dot);
  const providedHmac = fromBase64Url(token.slice(dot + 1));
  const expected = computeHmac(key, invitation_id);
  if (providedHmac.length !== expected.length) return { invitation_id, ok: false };
  const ok = timingSafeEqual(providedHmac, expected);
  return { invitation_id, ok };
}
