// #1604 — shared jose HS256 compact-JWS idiom that the three bespoke HMAC
// token schemes (email unsubscribe/companion, group invitations, anon chat
// session) consolidate onto. Each caller passes its own key bytes and a
// per-purpose `aud` claim, so a token minted for one purpose can never verify
// under another even when two callers share the same underlying secret.

import { SignJWT, jwtVerify } from "jose";

export function isCompactJws(token: string): boolean {
  return token.split(".").length === 3;
}

export async function signHmacJwt(
  payload: Record<string, unknown>,
  key: Uint8Array,
  purpose: string,
  expEpochSeconds?: number,
): Promise<string> {
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setAudience(purpose);
  if (expEpochSeconds !== undefined) jwt.setExpirationTime(expEpochSeconds);
  return jwt.sign(key);
}

export async function verifyHmacJwt<T extends Record<string, unknown>>(
  token: string,
  key: Uint8Array,
  purpose: string,
): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, key, { audience: purpose });
    const { aud: _aud, iss: _iss, sub: _sub, iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...rest } = payload;
    return rest as T;
  } catch {
    return null;
  }
}
