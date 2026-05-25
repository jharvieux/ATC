/** Spec ref: §7.1 — Complete signup (tenant provisioning after email confirm) */

import { assertPermission } from "@/lib/auth/assert-permission";

// §35.2.2 — when this route is built out, the final step (after
// users + tenants rows are committed) should call:
//
//   const svc = createServiceRoleClient();
//   const pending = readPendingAttributionFromHeader(req.headers.get("cookie"));
//   await bindContactOnIdentification({
//     svc, tenant_id, user_id,
//     source_origin: pending ? "utm_parsed" : "agent_set",
//     pending_payload: pending ?? null,
//   });
//   // Then clear the cookie in the response:
//   //   res.headers.append("Set-Cookie",
//   //     `${ATTRIBUTION_PENDING_COOKIE}=; Path=/; Max-Age=0`);
//
// See apps/main/src/lib/attribution/bind-contact-on-identification.ts
// and the analogous wire-up in inngest/transfer-finalize.ts.

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "auth", action: "signup:complete" });
    void ctx;
    // TODO(tenant-create): after tenant INSERT commits, call:
    //   publishTenantEvent({ event_type: 'tenant.created', tenant_id, source_revision: 0, payload: { status, tenant_type, display_name } })
    return Response.json({ todo: "Complete signup / provision tenant", spec_section: "§7.1" }, { status: 501 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
