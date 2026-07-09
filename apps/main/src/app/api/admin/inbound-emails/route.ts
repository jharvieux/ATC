// #890 Phase 1 — platform-admin list of inbound persona-address emails.
//
// GET /api/admin/inbound-emails?unresolved=true → newest-first rows (metadata
// only, no bodies). The design routes unresolved mail (tenant_id NULL) here
// instead of dropping it; tenant-resolved rows are also listable for triage.
// Admin UI page is Phase 2 (#890 follow-up) — this API is the Phase 1 surface.

import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPlatformAdminArea(req, "email_samples");
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const unresolvedOnly = new URL(req.url).searchParams.get("unresolved") === "true";

  const svc = createServiceRoleClient();
  let query = svc
    .from("inbound_emails")
    .select(
      "id, provider_message_id, tenant_id, contact_id, from_email, to_email, subject, resolution, spf_result, dkim_result, forwarded_email_log_id, received_at",
    )
    .order("received_at", { ascending: false })
    .limit(100);
  if (unresolvedOnly) query = query.is("tenant_id", null);

  const { data, error } = await query;
  if (error) return dbErrorResponse(error);

  return Response.json({ inbound_emails: data ?? [] });
}
