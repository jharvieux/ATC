// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// BP34 §34.1 / §34.3 — Manual entry intake.
//
// Smallest intake path: agent fills a CRM form and submits a free-text
// blob describing the lead (or pastes a screenshot of the lead-board
// entry as text). The pipeline classifies and extracts just like the
// email path.
//
// Request body:
//   { text: string, document_type_hint?: string }
//
// document_type_hint, when present, short-circuits the Haiku classifier
// for the case where the agent knows what they're entering (lead vs.
// intake form). The pipeline still runs validation + auto-accept.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertIntakePathPermitted } from "@/lib/import/tier-gate";
import { inngest } from "@/inngest/client";

const MAX_TEXT_BYTES = 100_000;

const VALID_HINTS = new Set([
  "lead_notification",
  "booking_confirmation",
  "commission_statement",
  "intake_form",
]);

export async function POST(req: Request): Promise<Response> {
  const { ctx, user } = await assertPermission(req, {
    resource: "imports.manual",
    action: "create",
  });

  // §34.9 tier gate.
  const svc = createServiceRoleClient();
  const gate = await assertIntakePathPermitted(ctx.tenant_id, "manual", svc);
  if (!gate.ok) {
    return Response.json({ error: gate.reason }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { text?: unknown; document_type_hint?: unknown } | null;
  if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.text, "utf8") > MAX_TEXT_BYTES) {
    return Response.json({ error: "text exceeds 100KB limit" }, { status: 413 });
  }

  const hint = typeof body.document_type_hint === "string" ? body.document_type_hint : null;
  if (hint && !VALID_HINTS.has(hint)) {
    return Response.json({ error: `document_type_hint must be one of ${[...VALID_HINTS].join(",")}` }, { status: 400 });
  }

  // Manual entries skip virus scan (no file) and skip classification when
  // a hint is provided. We enter at pending_classification regardless and
  // let the pipeline handle the hint by pre-populating document_type;
  // classifier will recognize the column is non-null and skip.
  const { data: inserted, error: insErr } = await svc
    .from("import_queue")
    .insert({
      tenant_id: ctx.tenant_id,
      import_path: "manual",
      source_ref: body.text, // §34: manual entries stuff the body into source_ref directly
      submitted_by_user_id: user.id,
      status: "pending_classification",
      document_type: hint,
      classification_confidence: hint ? 1 : null,
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    return Response.json({ error: `queue_insert_failed: ${insErr?.message ?? "unknown"}` }, { status: 500 });
  }

  const queueRowId = (inserted as { id: string }).id;
  await inngest.send({
    name: "import.queued",
    data: { tenant_id: ctx.tenant_id, import_queue_id: queueRowId },
  });

  return Response.json({ import_queue_id: queueRowId, status: "queued" }, { status: 202 });
}
