// @atc/contracts/service-jwt — the shared claim shape for the main→rag service
// JWT (§8.3 / BP09).
//
// The signer (apps/main/src/lib/rag-auth/sign-service-jwt.ts) mints tokens with
// these claims; the verifier (apps/rag/src/lib/auth/verify-service-jwt.ts) reads
// them back out of an untrusted, jose-decoded payload. Before this module the
// shape was hand-mirrored on both sides and free to drift. Defining it once here
// keeps producer and consumer in lockstep.
//
// This is the CLAIM shape only. Signing options (ttl) and the verification
// checks (signature, exp/iat window, replay, tenant lookup) stay with their
// respective modules — this module changes types, never security logic.

import { z } from "zod";

// iss/aud registered-claim values for the main→rag service JWT (#1773,
// required as of the #1843 strict flip).
// Defense-in-depth: even if SERVICE_JWT_PRIVATE_KEY were reused to mint tokens
// for another purpose, those tokens would carry a different (or absent) aud and
// be rejected by the rag verifier. Signer sets both unconditionally; verifier
// hard-rejects absence or mismatch (see verify-service-jwt.ts). These are
// fixed protocol constants, not env-tunable — both services must agree on the
// exact strings.
export const SERVICE_JWT_ISSUER = "atc-main" as const;
export const SERVICE_JWT_AUDIENCE = "atc-rag" as const;

export const ServiceJwtClaimsSchema = z.object({
  tenant_id: z.string().uuid(),
  scope: z.enum(["read", "write"]),
  // Identifies the calling service so the receiver can apply per-service
  // authorization (e.g. platform-admin endpoints check for "platform-admin").
  service_identifier: z.string().optional(),
  user_id: z.string().nullable().optional(),
  persona_id: z.string().nullable().optional(),
  // Registered iss/aud claims (#1773). Required as of the #1843 strict flip:
  // the signer has emitted both unconditionally since #1842, and that release
  // has been live long enough that no in-flight token can predate it.
  iss: z.literal(SERVICE_JWT_ISSUER),
  aud: z.literal(SERVICE_JWT_AUDIENCE),
});

export type ServiceJwtClaims = z.infer<typeof ServiceJwtClaimsSchema>;
