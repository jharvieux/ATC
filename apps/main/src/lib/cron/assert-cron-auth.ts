// Shared auth gate for all Vercel cron routes.
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.
// Returns a 401 Response when auth fails, null when the caller may proceed.
// Fail-closed: with no member of the rotation set configured, every request
// is rejected.
//
// #2047 / D-091 #28 — constant-time compare against the CRON_SECRET_CURRENT/
// _PREVIOUS rotation set. CRON_SECRET stays accepted: it is both the legacy
// single var and the variable Vercel itself reads to build the cron request's
// Bearer header, so rotation is: set _PREVIOUS to the old value, update
// CRON_SECRET (+_CURRENT) to the new one, redeploy, then drop _PREVIOUS.

import "server-only";

import { matchesRotatingSecret } from "@/lib/auth/rotating-secret";

export function assertCronAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const ok = matchesRotatingSecret(token, [
    process.env.CRON_SECRET_CURRENT,
    process.env.CRON_SECRET_PREVIOUS,
    process.env.CRON_SECRET,
  ]);
  if (!ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
