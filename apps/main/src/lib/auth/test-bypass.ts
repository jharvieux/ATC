// Test-only auth bypass for E2E specs (Tier-2 Playwright + integration tests).
//
// Why this exists:
//   tenantContextFromRequest() and assertPermission() both call
//   supabase.auth.getUser() against a real GoTrue endpoint. In E2E we run
//   against a vanilla local Postgres with no Supabase Auth — so we need a
//   way to assert a known user identity without GoTrue.
//
// Threat model:
//   This MUST never be live in production. Four locks:
//     1. NODE_ENV must NOT be "production".
//     2. VERCEL_ENV must NOT be "production". Belt-and-suspenders against
//        an env misconfiguration that ships preview-tier credentials with
//        a "development" NODE_ENV onto a prod host. Audit pass 2,
//        Finding 7 flagged that the middleware-side bypass got this check
//        but the assertPermission-side path (this file) did not.
//     3. TEST_AUTH_BYPASS_TOKEN env var must be set (the secret).
//     4. The request's Authorization header must be exactly
//        `Bearer ${TEST_AUTH_BYPASS_TOKEN}`.
//   Any one of these missing → tryTestBypass returns null and callers
//   fall through to the real Supabase auth path.
//
// Production deploys (Vercel) MUST NOT set TEST_AUTH_BYPASS_TOKEN. The
// boot-time env schema does not even list it — it's read via direct
// process.env lookup so the var stays out of the canonical config surface.

import "server-only";

export interface TestBypassIdentity {
  auth_user_id: string;
  tenant_id: string;
}

export function tryTestBypass(req: Request): TestBypassIdentity | null {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.VERCEL_ENV === "production") return null;
  const expected = process.env.TEST_AUTH_BYPASS_TOKEN;
  if (!expected) return null;
  const authUserId = process.env.TEST_AUTH_BYPASS_USER_ID;
  const tenantId = process.env.TEST_AUTH_BYPASS_TENANT_ID;
  if (!authUserId || !tenantId) return null;

  const header = req.headers.get("authorization");
  if (!header) return null;
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
  // Constant-time-ish comparison via Buffer.compare to avoid leaking timing.
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return null;
  if (Buffer.compare(Buffer.from(token), Buffer.from(expected)) !== 0) return null;

  return { auth_user_id: authUserId, tenant_id: tenantId };
}
