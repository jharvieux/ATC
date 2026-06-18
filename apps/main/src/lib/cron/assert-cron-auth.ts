// Shared auth gate for all Vercel cron routes.
// Vercel sends Authorization: Bearer <CRON_SECRET> on every invocation.
// Returns a 401 Response when auth fails, null when the caller may proceed.
// Fail-closed: an unset CRON_SECRET rejects every request.

export function assertCronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
