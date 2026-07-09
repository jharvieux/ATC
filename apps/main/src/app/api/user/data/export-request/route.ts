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
// The isolation layers here are: (1) app-layer — the verified auth_user_id from
// authenticateUser() scopes every read/write; (2) DB-layer — the RLS policy
// `auth_user_id = auth.uid()` on user_data_export_requests. A user can only ever
// see or create their own export requests.

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

  // Rate limit: 1 export per 30 days.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
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

  // Insert the export request row.
  const { data: row, error: insertErr } = await db
    .from("user_data_export_requests")
    .insert({ auth_user_id: authUserId })
    .select("id")
    .single();

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
