// §17.9 — CCPA data export request.
// POST: creates an export job for the authenticated user.
// Rate-limited: 1 request per 30 days.
//
// Isolation model (#1591): unlike delete/undo, this route is NOT tenant-scoped
// by design. A CCPA export is the user's COMPLETE data across every tenant they
// belong to (see collectUserDbExport in inngest/user-data-export-build.ts,
// which deliberately iterates all of a user's tenant rows), so the
// user_data_export_requests table has no tenant_id column and adding a
// `.eq("tenant_id", …)` filter would break the statutory cross-tenant contract.
// Isolation here is app-layer only under service role: this route uses
// createServiceRoleClient(), which BYPASSES RLS (auth.uid() is NULL), so the
// verified auth_user_id from authenticateUser() scoping every read/write is the
// SOLE enforced layer (#1703 audit). The `auth_user_id = auth.uid()` RLS policy
// on user_data_export_requests is defense-in-depth for any non-service-role
// path only — it does not apply to this handler.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { authenticateUser } from "@/lib/auth/authenticate-user";

export async function POST(req: Request): Promise<Response> {
  const authed = await authenticateUser(req);
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authed.authUserId;

  const db = createServiceRoleClient();

  // Rate limit: 1 export per 30 days (rolling). This SELECT is the exact
  // enforcement; the unique index on (auth_user_id, window_bucket) is the
  // DB-level backstop against the concurrent double-submit race (#1705).
  const WINDOW_SECONDS = 30 * 24 * 60 * 60;
  const thirtyDaysAgo = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();
  const { data: existing } = await db
    .from("user_data_export_requests")
    .select("id, requested_at")
    .eq("auth_user_id", authUserId)
    .gte("requested_at", thirtyDaysAgo)
    .limit(1);

  if (existing && existing.length > 0) {
    return Response.json(
      { error: "rate_limited", message: "Only 1 export request per 30 days." },
      { status: 429 },
    );
  }

  // Insert the export request row. window_bucket collides for two concurrent
  // requests (same instant → same bucket) so exactly one insert wins; the
  // loser hits the unique constraint (23505) and is rate-limited (#1705).
  const windowBucket = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const { data: row, error: insertErr } = await db
    .from("user_data_export_requests")
    .insert({ auth_user_id: authUserId, window_bucket: windowBucket })
    .select("id")
    .single();

  if (insertErr && (insertErr as { code?: string }).code === "23505") {
    // Lost the concurrent-insert race against a sibling request in the same
    // window — treat identically to the app-layer rate-limit hit above.
    return Response.json(
      { error: "rate_limited", message: "Only 1 export request per 30 days." },
      { status: 429 },
    );
  }

  if (insertErr || !row) {
    // #1591 — a null `row` with a null `insertErr` (insert reported success but
    // returned nothing) previously logged an empty db-error, making it
    // undiagnosable. Synthesize an error so the log line names the cause.
    return dbErrorResponse(
      insertErr ?? new Error("export-request: insert returned no row"),
    );
  }

  const exportRequestId = (row as { id: string }).id;

  // Queue the build job.
  await inngest.send({
    name: "user.data_export_requested",
    data: { auth_user_id: authUserId, export_request_id: exportRequestId },
  });

  return Response.json({ ok: true, export_request_id: exportRequestId });
}
