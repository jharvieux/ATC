// BP34 §34.6 — Signed URL for the uploaded source document.
//
// Returns a 302 redirect to a short-lived (5 min) signed URL into the
// private imported-documents bucket. Takes the import_queue row id — never
// a storage path — so the signed path always comes from a tenant-scoped DB
// row, not the request (#2050: a caller-supplied path guarded by a prefix
// check is not a containment check).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const SIGNED_URL_TTL_SECONDS = 300;

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "imports.review", action: "read" });

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("import_queue")
      .select("uploaded_file_path")
      .eq("id", id)
      .maybeSingle();
    if (error) return dbErrorResponse(error);
    const row = data as { uploaded_file_path: string | null } | null;
    if (!row?.uploaded_file_path) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const { data: signed, error: signErr } = await db.storage
      .from("imported-documents")
      .createSignedUrl(row.uploaded_file_path, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      if (signErr) return dbErrorResponse(signErr);
      const ref = crypto.randomUUID();
      console.error("[imports/source-file] ref=%s signing_failed no signedUrl returned", ref);
      return Response.json({ error: "signing_failed", ref }, { status: 500 });
    }

    return Response.redirect(signed.signedUrl, 302);
  } catch (err) {
    return respondToAuthError(err);
  }
}
