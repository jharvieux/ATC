// §16.3 — Tenant-initiated custom-domain request.
//
// The actual domain attachment is operator-driven (DNS instructions, cert
// issuance) — see /api/admin/tenants/[id]/custom-domain. This endpoint is
// the structured form of the support email the branding page used to
// generate via mailto. It records the request, fires an operator alert,
// and writes an audit row so the request is queryable by tenant.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { writeAuditLog } from "@/lib/audit/write";

interface RequestBody {
  desired_hostname: string;
  notes?: string;
}

// Bare hostname shape — labels of letters/digits/hyphens, ≥2 labels, ≤253 total.
// Intentionally narrow: rejects schemes, ports, paths, IPs, underscores.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "tenant_branding", action: "write" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx, user } = auth;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const hostname = (body.desired_hostname ?? "").trim().toLowerCase();
  if (!hostname) {
    return Response.json({ error: "desired_hostname_required" }, { status: 422 });
  }
  if (!HOSTNAME_RE.test(hostname)) {
    return Response.json({ error: "invalid_hostname_format" }, { status: 422 });
  }

  const notes = (body.notes ?? "").trim().slice(0, 500);

  // Record the request as an audit row + an operator alert. The audit row
  // is the durable queryable record; the alert is the operator's
  // notification surface.
  await writeAuditLog({
    tenant_id: ctx.tenant_id,
    actor_type: "user",
    actor_user_id: user.id,
    action: "tenant.custom_domain_requested",
    resource_type: "tenant",
    resource_id: ctx.tenant_id,
    changes: { desired_hostname: hostname, notes: notes || null },
  });

  await sendOperatorAlert({
    severity: "low",
    signal: "tenant_custom_domain_requested",
    detail: `Tenant ${ctx.tenant_id} requested custom domain ${hostname}.${notes ? ` Notes: ${notes}` : ""}`,
    payload: {
      tenant_id: ctx.tenant_id,
      requested_by_user_id: user.id,
      desired_hostname: hostname,
      notes: notes || null,
    },
  });

  return Response.json({
    ok: true,
    received: true,
    desired_hostname: hostname,
    note: "Our team will email you DNS instructions and provision the certificate. Typical turnaround: 1 business day.",
  });
}
