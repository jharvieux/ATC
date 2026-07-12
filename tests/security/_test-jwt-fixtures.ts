// Test-only HS256 JWT fixtures for the local Tier-2 / Tier-2.5 stack.
//
// Why generated at runtime rather than embedded as literals:
//   - GitGuardian (and other secret scanners) pattern-match JWT-shaped
//     strings with role=service_role and flag them as Supabase service
//     keys. The committed literals were a false positive — they were
//     signed with a publicly-documented test secret — but a public-repo
//     alert is noise we don't need.
//   - The runtime helper builds the same tokens the local PostgREST
//     accepts (jwt-secret in scripts/local-postgrest.conf), so the
//     test behaviour is identical; only the source representation
//     changes.
//
// SECURITY: this secret is intentionally weak and committed. It is
// VALID ONLY against a local PostgREST instance configured with the
// same jwt-secret. It grants no access to any real Supabase project.
// Do NOT use this pattern for any production-facing JWT.

import { createHmac } from "node:crypto";

// Must match scripts/local-postgrest.conf jwt-secret. Rotating this
// requires updating both files in lockstep.
const TEST_JWT_SECRET =
  "atc-local-test-only-ef23d2c129cb73c8-not-for-production";

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function signHs256(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(
    createHmac("sha256", TEST_JWT_SECRET).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}

/** Anon-role JWT (read-only access via PostgREST RLS policies). */
export const TEST_ANON_JWT = signHs256({ role: "anon", iss: "atc-local-test-only" });

/** Service-role JWT (bypasses RLS — local-test-only). */
export const TEST_SERVICE_ROLE_JWT = signHs256({ role: "service_role", iss: "atc-local-test-only" });
