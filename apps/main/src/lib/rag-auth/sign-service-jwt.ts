// §8.3 / BP09 — Mint an RS256 service JWT for main → rag calls.
//
// The rag side verifies these tokens via apps/rag/src/lib/auth/verify-service-jwt.ts.
// That verifier requires:
//   - alg=RS256
//   - kid header matching SERVICE_JWT_ACCEPTED_KEY_IDS on rag
//   - iat/exp within a ±5 minute window
//   - jti unique (Redis SETNX replay guard)
//   - tenant_id present (UUID) AND in tenant_registry_shadow
//   - scope ∈ {'read','write'}
//   - service_identifier for admin-only endpoints
//
// Until this module landed, callers were passing the raw SERVICE_JWT_PRIVATE_KEY
// PEM as a Bearer token. The rag verifier would have rejected those tokens
// with `signature_invalid` — so retrieve-for-chat and the cruisemapper
// ingest crons were silently 401ing in any environment with a real verifier
// configured. This module produces tokens the verifier actually accepts.

import "server-only";
import { SignJWT, importPKCS8 } from "jose";
import { randomUUID } from "node:crypto";
import type { ServiceJwtClaims } from "@atc/contracts";

// The claim shape is the shared @atc/contracts/ServiceJwtClaims; signing adds
// only the optional TTL override (env: SERVICE_JWT_TTL_SECONDS).
export type SignServiceJwtOptions = ServiceJwtClaims & {
  ttl_seconds?: number;
};

// Cached signing key — re-importing PKCS8 on every call is wasteful.
let cachedKey: { kid: string; key: CryptoKey } | null = null;

async function getSigningKey(): Promise<{ kid: string; key: CryptoKey }> {
  const kid = process.env.SERVICE_JWT_KEY_ID_CURRENT;
  const pemRaw = process.env.SERVICE_JWT_PRIVATE_KEY;
  if (!kid) throw new Error("signServiceJwt: SERVICE_JWT_KEY_ID_CURRENT not set");
  if (!pemRaw) throw new Error("signServiceJwt: SERVICE_JWT_PRIVATE_KEY not set");

  if (cachedKey && cachedKey.kid === kid) return cachedKey;

  // Allow either real newlines (file-loaded) or escaped \n (env-injected).
  const pem = pemRaw.replace(/\\n/g, "\n");
  const key = await importPKCS8(pem, "RS256");
  cachedKey = { kid, key };
  return cachedKey;
}

export async function signServiceJwt(opts: SignServiceJwtOptions): Promise<string> {
  const { kid, key } = await getSigningKey();
  const ttl = opts.ttl_seconds ?? Number(process.env.SERVICE_JWT_TTL_SECONDS ?? 300);
  const now = Math.floor(Date.now() / 1000);

  const builder = new SignJWT({
    tenant_id: opts.tenant_id,
    scope: opts.scope,
    ...(opts.service_identifier !== undefined && { service_identifier: opts.service_identifier }),
    ...(opts.user_id !== undefined && { user_id: opts.user_id }),
    ...(opts.persona_id !== undefined && { persona_id: opts.persona_id }),
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(randomUUID());

  return builder.sign(key);
}

// Test seam — lets unit tests clear the cached key between calls if they
// stub the env vars.
export function _resetSigningKeyCacheForTests(): void {
  cachedKey = null;
}
