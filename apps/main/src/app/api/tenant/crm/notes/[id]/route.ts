// §25.4a Category 3 — Edit the tenant's CRM note text on an anonymized contact.
//
// PATCH body: { notes: string | null }
// Updates contacts.notes for the contact ID. Tenant-scoped via RLS.
// Used by the /tenant-admin/crm/anonymized-notes review page to let admins
// redact residual PII from notes that were preserved (text) but had the
// customer FK anonymized.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function PATCH(
  req: Request,
  ctxParams: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "CRM note redaction",
      action: "patch",
    });
    const { id } = await ctxParams.params;
    const body = (await req.json()) as { notes?: string | null };

    if (typeof body.notes !== "string" && body.notes !== null) {
      return Response.json({ error: "invalid_notes" }, { status: 422 });
    }
    if (typeof body.notes === "string" && body.notes.length > 10_000) {
      return Response.json({ error: "notes_too_long" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("contacts")
      .update({ notes: body.notes, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
