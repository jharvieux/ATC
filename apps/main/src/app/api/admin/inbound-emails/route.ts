// #890 Phase 1 — platform-admin list of inbound persona-address emails.
//
// GET /api/admin/inbound-emails?unresolved=true → newest-first rows (metadata
// only, no bodies). The design routes unresolved mail (tenant_id NULL) here
// instead of dropping it; tenant-resolved rows are also listable for triage.
// Admin UI page is Phase 2 (#890 follow-up) — this API is the Phase 1 surface.

import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "email_samples")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const unresolvedOnly = new URL(req.url).searchParams.get("unresolved") === "true";

  try {
    const rows = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "cross_tenant_admin", operation: "inbound_emails.list" },
      async (db) => {
        let query = db
          .from("inbound_emails")
          .select(
            "id, provider_message_id, tenant_id, contact_id, from_email, to_email, subject, resolution, spf_result, dkim_result, forwarded_email_log_id, received_at",
          )
          .order("received_at", { ascending: false })
          .limit(100);
        if (unresolvedOnly) query = query.is("tenant_id", null);
        const { data, error } = await query;
        if (error) throw error;
        return data ?? [];
      },
    );
    return Response.json({ inbound_emails: rows });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
