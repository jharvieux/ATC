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

export const ServiceJwtClaimsSchema = z.object({
  tenant_id: z.string().uuid(),
  scope: z.enum(["read", "write"]),
  // Identifies the calling service so the receiver can apply per-service
  // authorization (e.g. platform-admin endpoints check for "platform-admin").
  service_identifier: z.string().optional(),
  user_id: z.string().nullable().optional(),
  persona_id: z.string().nullable().optional(),
});

export type ServiceJwtClaims = z.infer<typeof ServiceJwtClaimsSchema>;
