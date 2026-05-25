// BP35 §35.7.2 — Edit a contact's attribution source.
//
// Creates an `agent_edit` touch row (consumes a slot in the rolling 10
// per §35.4.4). First-touch on the contact is NOT modified — that's the
// §35.3.1 immutability guarantee.
//
// Tier gate: BYO Research can SET at creation but cannot EDIT after
// (§35.7.3). Other tiers permitted.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { recordIdentificationTouch } from "@/lib/attribution/record-touch";
import { writeAuditLog } from "@/lib/audit/write";
import { channelFromManualCategory } from "@/lib/attribution/channel-map";
import { emptyAttributionPayload } from "@/lib/attribution/types";

const EDIT_BLOCKED_TIERS: ReadonlySet<string> = new Set(["byo_research"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx, user } = await assertPermission(req, { resource: "crm.contacts", action: "edit_source" });
  const { id: contactId } = await params;

  const db = tenantClient(ctx);

  // §35.9 tier gate.
  const { data: tenantData } = await db
    .from("tenants")
    .select("tier_definitions!inner(code)")
    .eq("id", ctx.tenant_id)
    .maybeSingle();
  const tier = (tenantData as { tier_definitions?: { code?: string } | { code?: string }[] | null } | null)?.tier_definitions;
  const code = Array.isArray(tier) ? tier[0]?.code : tier?.code;
  if (code && EDIT_BLOCKED_TIERS.has(code)) {
    return Response.json({ error: `tier_does_not_permit_source_edit:${code}` }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    manual_label?: unknown;
    manual_category?: unknown;
  } | null;
  if (!body || typeof body.manual_label !== "string" || body.manual_label.trim().length === 0) {
    return Response.json({ error: "manual_label required" }, { status: 400 });
  }
  const manual_category = typeof body.manual_category === "string" ? body.manual_category.trim() : null;

  // Verify contact belongs to tenant.
  const { data: c } = await db
    .from("contacts")
    .select("id, tenant_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!c || (c as { tenant_id: string }).tenant_id !== ctx.tenant_id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const payload = {
    ...emptyAttributionPayload(),
    manual_label: body.manual_label.trim(),
    manual_category,
    channel: channelFromManualCategory(manual_category),
  };

  const result = await recordIdentificationTouch(
    {
      tenant_id: ctx.tenant_id,
      contact_id: contactId,
      is_new_contact: false,
      source_origin: "agent_edit",
      editor_user_id: user.id,
      payload,
    },
    db,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: 500 });

  await writeAuditLog({
    tenant_id: ctx.tenant_id,
    actor_user_id: user.id,
    actor_type: "user",
    action: "attribution.contact_source_edited",
    resource_type: "contact",
    resource_id: contactId,
    context: {
      manual_label: payload.manual_label,
      manual_category: payload.manual_category,
      touch_id: result.touch_id,
    },
  });

  return Response.json({ ok: true, touch_id: result.touch_id });
}
