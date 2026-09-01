// BP31 §32.6.1 / §32.3.3 — Poll status of a help-docs export job.
//
// Returns: { state: 'pending'|'ready'|'failed', signed_url?: string }

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour per §32.3.3

export async function GET(req: Request, props: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx } = await assertPermission(req, { resource: "help_docs", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("help_doc_versions")
      .select("storage_path, format, expires_at")
      .eq("id", params.jobId)
      .maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return Response.json({ error: "not_found" }, { status: 404 });
    const row = data as { storage_path: string; format: string; expires_at: string };
    if (!row.storage_path) {
      // Worker hasn't finished UPSERT yet.
      return Response.json({ state: "pending" });
    }

    const { data: signed } = await db.storage
      .from("help-docs")
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (!signed?.signedUrl) {
      return Response.json({ state: "failed", error: "could not sign storage URL" });
    }
    return Response.json({ state: "ready", signed_url: signed.signedUrl, format: row.format });
  } catch (err) {
    return respondToAuthError(err);
  }
}
