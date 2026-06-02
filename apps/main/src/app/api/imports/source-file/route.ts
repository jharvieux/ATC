// BP34 §34.6 — Signed URL for the uploaded source document.
//
// Returns a 302 redirect to a short-lived (5 min) signed URL into the
// private imported-documents bucket. Path must belong to the calling
// tenant or we 403.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

const SIGNED_URL_TTL_SECONDS = 300;

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "imports.review", action: "read" });

    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) return Response.json({ error: "path required" }, { status: 400 });

    // Tenant scope: path must start with <tenant_id>/.
    if (!path.startsWith(`${ctx.tenant_id}/`)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const svc = createServiceRoleClient();
    const { data, error } = await svc.storage
      .from("imported-documents")
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      return Response.json({ error: `signing_failed: ${error?.message ?? "unknown"}` }, { status: 500 });
    }

    return Response.redirect(data.signedUrl, 302);
  } catch (err) {
    return respondToAuthError(err);
  }
}
