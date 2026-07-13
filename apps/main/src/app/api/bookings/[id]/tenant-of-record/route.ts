// §20.7 — Tenant-of-record disclosure data for the booking Review stage.
//
// GET /api/bookings/[id]/tenant-of-record — the sub-host tenant (name +
// support email) and the platform host agency's legal name, for the
// TenantOfRecordDisclosure component. bookingId gates access (404s if the
// booking isn't in the caller's tenant) even though the returned tenant
// info comes from ctx.tenant_id, not the booking row itself.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { resolveHostAgencyLegalName } from "@/lib/platform/platform-setting-cache";

interface TenantRow {
  display_name: string | null;
  support_email: string | null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;
  const db = tenantClient(auth.ctx);

  const { data: booking, error: bookingErr } = await db
    .from("bookings")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (bookingErr) return dbErrorResponse(bookingErr);
  if (!booking) return Response.json({ error: "not_found" }, { status: 404 });

  const [
    { data: tenantData, error: tenantErr },
    { data: hostRow, error: hostErr },
  ] = await Promise.all([
    db.from("tenants").select("display_name, support_email").eq("id", auth.ctx.tenant_id).maybeSingle(),
    db.from("platform_settings").select("value").eq("key", "host_agency_legal_name").maybeSingle(),
  ]);
  if (tenantErr) return dbErrorResponse(tenantErr);
  if (hostErr) return dbErrorResponse(hostErr);

  const tenant = tenantData as TenantRow | null;

  // Fail-closed: a missing tenant/settings row yields null, never a
  // placeholder string — the client blocks submission on null.
  return Response.json({
    tenant: {
      name: tenant?.display_name ?? null,
      support_email: tenant?.support_email ?? "",
    },
    host_agency: {
      legal_name: resolveHostAgencyLegalName((hostRow as { value?: unknown } | null)?.value),
    },
  });
}
