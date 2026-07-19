// §8.3 — Service-to-service JWT verification with fail-closed contract
//
// FAIL-CLOSED CONTRACT (verbatim from §8.3):
//   Every branch of this function either returns a valid ServiceCallerContext
//   or throws a ServiceAuthError with a specific code and HTTP status.
//   There is NO "best effort" path. If Redis is unreachable, the request is
//   rejected (503). If the tenant is unknown, the request is rejected (403).
//   A single missed check is a security hole — treat it as one.
//
// Check sequence (MUST be preserved in this order):
//   1. Parse Authorization header              → missing_token    401
//   2. Verify RS256 signature + key ID         → signature_invalid 401
//   3. Verify exp/iat within ±5 min window     → expired           401
//   4. Redis SETNX jti replay check            → replay            401
//      (Redis unreachable)                     → redis_unreachable 503
//   5. tenant_id in tenant_registry_shadow     → tenant_unknown    403
//   6. shadow status === 'active'              → tenant_inactive   403
//   7. Any other error                         → internal          500

import { importSPKI, jwtVerify, type JWTPayload } from "jose";
import {
  SERVICE_JWT_AUDIENCE,
  SERVICE_JWT_ISSUER,
  type ServiceJwtClaims,
} from "@atc/contracts";
import { getRagDb } from "@/lib/db/supabase";
import { getRedis } from "@/lib/redis/client";

export type ServiceCallerContext = {
  tenant_id: string;
  user_id: string | null;
  service_identifier: string | null;
  persona_id: string | null;
  scope: "read" | "write";
  jti: string;
};

export class ServiceAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ServiceAuthError";
  }
}

// Untrusted, jose-decoded token: every claim is optional until validated below.
// Partial<ServiceJwtClaims> ties the field names/types to the shared contract
// without asserting presence — the fail-closed checks stay exactly as strong.
type ServiceJwtPayload = JWTPayload & Partial<ServiceJwtClaims>;

// Cache parsed public keys by key ID to avoid re-importing on every request.
const keyCache = new Map<string, CryptoKey>();

/**
 * Resolve the PEM for an incoming `kid` header.
 *
 * Greptile audit-followups #7 fix: previously every kid mapped to the same
 * SERVICE_JWT_PUBLIC_KEY, which made zero-downtime key rotation impossible —
 * during the overlap window, tokens signed with the OLD kid would still be
 * verified against the NEW PEM (and silently fail signature_invalid).
 *
 * New routing rule:
 *   - kid === SERVICE_JWT_KEY_ID_CURRENT  → SERVICE_JWT_PUBLIC_KEY
 *   - kid === SERVICE_JWT_KEY_ID_PREVIOUS → SERVICE_JWT_PUBLIC_KEY_PREVIOUS
 *   - else → signature_invalid (the kid allowlist check upstream catches this
 *     too, but a kid that's allowlisted yet not mapped is itself a config bug)
 *
 * Env validation in apps/rag/src/lib/env.ts enforces that both halves of each
 * pair are set together and that both kids appear in SERVICE_JWT_ACCEPTED_KEY_IDS.
 */
async function getPublicKey(kid: string): Promise<CryptoKey> {
  if (keyCache.has(kid)) return keyCache.get(kid)!;

  const currentKid = process.env.SERVICE_JWT_KEY_ID_CURRENT;
  const previousKid = process.env.SERVICE_JWT_KEY_ID_PREVIOUS;

  let pem: string | undefined;
  if (kid === currentKid) {
    pem = process.env.SERVICE_JWT_PUBLIC_KEY?.replace(/\\n/g, "\n");
  } else if (previousKid && kid === previousKid) {
    pem = process.env.SERVICE_JWT_PUBLIC_KEY_PREVIOUS?.replace(/\\n/g, "\n");
  } else {
    throw new ServiceAuthError("signature_invalid", 401, `kid '${kid}' has no mapped PEM`);
  }

  if (!pem) {
    throw new ServiceAuthError(
      "internal",
      500,
      `kid '${kid}' mapped env var is unset (config drift)`,
    );
  }
  const key = await importSPKI(pem, "RS256");
  keyCache.set(kid, key);
  return key;
}

export async function verifyServiceJwt(req: Request): Promise<ServiceCallerContext> {
  // Step 1: Parse Authorization header
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ServiceAuthError("missing_token", 401);
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new ServiceAuthError("missing_token", 401);

  // Step 2: Verify RS256 signature + accepted key IDs
  const acceptedKids = (process.env.SERVICE_JWT_ACCEPTED_KEY_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let payload: ServiceJwtPayload;
  let jti: string;

  try {
    // We need the header kid before we can pick the right key.
    // jose's jwtVerify accepts a key function for multi-kid support.
    const result = await jwtVerify<ServiceJwtPayload>(
      token,
      async (header) => {
        const kid = header.kid ?? "";
        if (!acceptedKids.includes(kid)) {
          throw new ServiceAuthError("signature_invalid", 401, `kid '${kid}' not accepted`);
        }
        return getPublicKey(kid);
      },
      { algorithms: ["RS256"] },
    );
    payload = result.payload;
  } catch (err) {
    if (err instanceof ServiceAuthError) throw err;
    throw new ServiceAuthError("signature_invalid", 401);
  }

  // Step 2.5: iss/aud defense-in-depth (#1773, strict flip #1843)
  // Both claims are now REQUIRED — absence and mismatch are both rejected.
  // The tolerant rollout window (warn-log + allow absence) has closed: #1842
  // shipped the signer stamping iss/aud unconditionally, and that release has
  // been live on atc-main long enough that no valid short-TTL token in flight
  // can predate it. A key reused to mint tokens for another purpose (or a
  // pre-rollout stale token) carries a wrong-or-absent iss/aud and is
  // rejected here.
  // Read as widened strings: payload is untrusted, so the mismatch branches
  // must stay live (the schema's literal iss/aud types would otherwise narrow
  // these to the trusted values and make the checks statically dead).
  const issClaim: string | undefined = payload.iss;
  const audClaim: string | string[] | undefined = payload.aud;
  const audValues = Array.isArray(audClaim)
    ? audClaim
    : audClaim !== undefined
      ? [audClaim]
      : [];
  if (issClaim === undefined || issClaim !== SERVICE_JWT_ISSUER) {
    throw new ServiceAuthError("signature_invalid", 401, "iss missing or mismatched");
  }
  if (audValues.length === 0 || !audValues.includes(SERVICE_JWT_AUDIENCE)) {
    throw new ServiceAuthError("signature_invalid", 401, "aud missing or mismatched");
  }

  // Step 3: Verify exp/iat within ±5-minute window
  // jose already checks exp; we add an iat check for max age.
  const now = Math.floor(Date.now() / 1000);
  const MAX_AGE_SECS = 5 * 60;

  if (!payload.iat || now - payload.iat > MAX_AGE_SECS) {
    throw new ServiceAuthError("expired", 401);
  }
  if (!payload.exp || payload.exp < now) {
    throw new ServiceAuthError("expired", 401);
  }

  // Step 4: Redis jti replay check — FAIL CLOSED if Redis unreachable
  if (!payload.jti) throw new ServiceAuthError("signature_invalid", 401, "missing jti");
  jti = payload.jti;

  const ttl = (payload.exp - now) + 30; // token TTL + 30s buffer

  try {
    const redis = getRedis();
    const set = await redis.set(`jti:${jti}`, "1", "EX", ttl, "NX");
    if (set === null) {
      // Key already existed — replay
      throw new ServiceAuthError("replay", 401);
    }
  } catch (err) {
    if (err instanceof ServiceAuthError) throw err;
    // Any Redis error (connection refused, timeout, etc.) → fail closed
    throw new ServiceAuthError("redis_unreachable", 503);
  }

  // Step 5: Lookup tenant in shadow table
  if (!payload.tenant_id) throw new ServiceAuthError("tenant_unknown", 403, "missing tenant_id claim");

  const supabase = getRagDb();

  const { data: shadowRow, error } = await supabase
    .from("tenant_registry_shadow")
    .select("tenant_id, status")
    .eq("tenant_id", payload.tenant_id)
    .maybeSingle();

  if (error) throw new ServiceAuthError("internal", 500, error.message);
  if (!shadowRow) throw new ServiceAuthError("tenant_unknown", 403);

  // Step 6: Check shadow status
  if (shadowRow.status !== "active") {
    throw new ServiceAuthError("tenant_inactive", 403);
  }

  return {
    tenant_id: payload.tenant_id,
    user_id: payload.user_id ?? null,
    service_identifier: payload.service_identifier ?? null,
    persona_id: payload.persona_id ?? null,
    scope: payload.scope === "write" ? "write" : "read",
    jti,
  };
}
