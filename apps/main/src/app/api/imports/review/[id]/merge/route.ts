// BP34 §34.6 — Merge an import-review item into an existing contact.
//
// Semantics (operator-confirmed): field-level, non-destructive.
//   For each field on the existing contact: if it is null/empty, take
//   the value from the import; otherwise leave it alone. The 'notes'
//   field is the only exception — non-empty existing + non-empty import
//   are concatenated with a separator + provenance line.
//
// This is safer than overwrite (preserves tenant edits) and lighter
// than a per-field picker UI (no extra round-trips). Operators who need
// finer control can reject + re-create the contact manually.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type Body = { target_contact_id: string };

// Contact fields we'll fill in from the import. Excludes keys that should
// never be overwritten by an import (id, tenant_id, user_id, created_at,
// updated_at, pipeline_stage_key, etc.) — those stay frozen.
const MERGEABLE_TEXT_FIELDS = [
  "first_name",
  "last_name",
  "middle_name",
  "preferred_name",
  "email",
  "phone",
  "date_of_birth",
  "gender",
  "nationality",
  "passport_number",
  "passport_expiry",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "country",
] as const;

const NOTES_FIELD = "notes" as const;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim().length === 0);
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await props.params;
    const { ctx, user } = await assertPermission(req, { resource: "imports.review", action: "accept" });
    const svc = createServiceRoleClient();
    const queueRowId = params.id;

    let body: Body;
    try {
      const raw = (await req.json()) as Body;
      if (!raw.target_contact_id || typeof raw.target_contact_id !== "string") {
        throw new Error("missing target_contact_id");
      }
      body = raw;
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    // Load the queue row.
    const { data: rowData, error: loadErr } = await svc
      .from("import_queue")
      .select("id, tenant_id, status, raw_extracted_fields, document_type")
      .eq("id", queueRowId)
      .maybeSingle();
    if (loadErr) return dbErrorResponse(loadErr);
    if (!rowData) return Response.json({ error: "not_found" }, { status: 404 });
    const row = rowData as {
      id: string;
      tenant_id: string;
      status: string;
      raw_extracted_fields: Record<string, unknown> | null;
      document_type: string | null;
    };
    if (row.tenant_id !== ctx.tenant_id) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (row.status !== "pending_review") {
      return Response.json({ error: `row_not_in_pending_review:${row.status}` }, { status: 409 });
    }
    if (row.document_type === "commission_statement") {
      return Response.json({ error: "merge_not_supported_for_commission_statement" }, { status: 400 });
    }

    // Load the target contact + tenant-scope check.
    const { data: contactData, error: contactErr } = await svc
      .from("contacts")
      .select("*")
      .eq("id", body.target_contact_id)
      .maybeSingle();
    if (contactErr) return dbErrorResponse(contactErr);
    if (!contactData) return Response.json({ error: "target_contact_not_found" }, { status: 404 });
    const contact = contactData as Record<string, unknown>;
    if (contact.tenant_id !== ctx.tenant_id) {
      return Response.json({ error: "target_contact_forbidden" }, { status: 403 });
    }

    // Build the update payload from non-empty import fields where the
    // existing contact field is blank.
    const extracted = (row.raw_extracted_fields ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const filled: string[] = [];
    for (const field of MERGEABLE_TEXT_FIELDS) {
      const incoming = extracted[field];
      if (isBlank(incoming)) continue;
      if (isBlank(contact[field])) {
        update[field] = incoming;
        filled.push(field);
      }
    }

    // Notes: always append if there's incoming text, with a provenance line.
    const incomingNotes = extracted[NOTES_FIELD];
    if (typeof incomingNotes === "string" && incomingNotes.trim().length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const provenance = `\n\n--- Imported ${stamp} ---\n${incomingNotes.trim()}`;
      const existing = typeof contact[NOTES_FIELD] === "string" ? (contact[NOTES_FIELD] as string) : "";
      update[NOTES_FIELD] = (existing + provenance).trim();
      filled.push("notes");
    }

    if (Object.keys(update).length === 0) {
      // Nothing to merge — the import had no values that the existing
      // contact didn't already have. Still mark the queue row accepted so
      // the reviewer doesn't see it again.
      await markQueueRowMerged(svc, queueRowId, user.id, body.target_contact_id, []);
      await writeAuditLog({
        tenant_id: ctx.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "import.merged_noop",
        resource_type: "contact",
        resource_id: body.target_contact_id,
        context: { import_queue_id: queueRowId },
      });
      return Response.json({ merged: true, contact_id: body.target_contact_id, fields_filled: [], noop: true });
    }

    const { error: updateErr } = await svc
      .from("contacts")
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq("id", body.target_contact_id);
    if (updateErr) return dbErrorResponse(updateErr);

    await markQueueRowMerged(svc, queueRowId, user.id, body.target_contact_id, filled);

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "import.merged",
      resource_type: "contact",
      resource_id: body.target_contact_id,
      context: { import_queue_id: queueRowId, fields_filled: filled },
    });

    return Response.json({ merged: true, contact_id: body.target_contact_id, fields_filled: filled });
  } catch (err) {
    return respondToAuthError(err);
  }
}

async function markQueueRowMerged(
  svc: ReturnType<typeof createServiceRoleClient>,
  queueRowId: string,
  userId: string,
  targetContactId: string,
  fieldsFilled: string[],
): Promise<void> {
  const purgable_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await safeAwait(svc
    .from("import_queue")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: userId,
      purgable_at,
      raw_extracted_fields: {
        _merge: { target_contact_id: targetContactId, fields_filled: fieldsFilled },
      },
    })
    .eq("id", queueRowId), "import_queue.update");
}
