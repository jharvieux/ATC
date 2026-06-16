// BP34 §34.6 — Accept (or "edit and accept") a review-queue item.
//
// Request body (all optional):
//   { edited_fields?: object, commission_rate?: number }
//
// edited_fields: if present, replaces raw_extracted_fields on the queue
// row before promotion runs. The agent's edit is the source of truth.
//
// commission_rate: §34.7.3 step 3 — when the row sat in review with
// reason='commission_rate_missing', the agent enters a rate here. We
// stamp it onto raw_extracted_fields.commission_rate before calling the
// promoter, which will then resolve via the doc_parsed branch — but with
// commission_rate_source='agent_set' to record the source correctly.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { promoteImport } from "@/lib/import/promote";
import { matchStatementLineItems } from "@/lib/import/match-statement-line-items";
import type { CommissionStatementFields } from "@/lib/import/extractors/types";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type Body = {
  edited_fields?: Record<string, unknown>;
  commission_rate?: number;
};

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await props.params;
    const { ctx, user } = await assertPermission(req, { resource: "imports.review", action: "accept" });
    const svc = createServiceRoleClient();
    const queueRowId = params.id;

    const body = ((await req.json().catch(() => ({}))) ?? {}) as Body;

    // Load + tenant-scope check.
    const { data: rowData, error: loadErr } = await svc
      .from("import_queue")
      .select("id, tenant_id, status, raw_extracted_fields, document_type")
      .eq("id", queueRowId)
      .maybeSingle();
    if (loadErr) return dbErrorResponse(loadErr);
    if (!rowData) return Response.json({ error: "not_found" }, { status: 404 });
    const row = rowData as { id: string; tenant_id: string; status: string; raw_extracted_fields: Record<string, unknown> | null; document_type: string | null };
    if (row.tenant_id !== ctx.tenant_id) return Response.json({ error: "forbidden" }, { status: 403 });
    if (row.status !== "pending_review") {
      return Response.json({ error: `row_not_in_pending_review:${row.status}` }, { status: 409 });
    }

    // Merge agent edits + commission_rate into raw_extracted_fields.
    const merged: Record<string, unknown> = { ...(row.raw_extracted_fields ?? {}) };
    if (body.edited_fields && typeof body.edited_fields === "object") {
      Object.assign(merged, body.edited_fields);
    }
    // §34.7.3 — agent-supplied rate. We record it on the row but flag the
    // commission_rate_source as 'agent_set' below via a special context
    // marker. The promoter reads raw_extracted_fields.commission_rate
    // through the resolveCommissionRate's step 1 path → source='doc_parsed',
    // which is wrong; we therefore short-circuit the source AFTER promotion
    // by updating the commissions row when this branch was used.
    let agentSetRate = false;
    if (typeof body.commission_rate === "number" && body.commission_rate > 0) {
      merged.commission_rate = body.commission_rate;
      agentSetRate = true;
    }

    if (body.edited_fields || agentSetRate) {
      await safeAwait(svc
        .from("import_queue")
        .update({ raw_extracted_fields: merged, parse_failure_reason: null })
        .eq("id", queueRowId), "import_queue.update");
    }

    // §34.5.4 — commission_statement doesn't go through promoteImport (no
    // contact/booking/commission writes). Instead we run the §34.5.4 +
    // §14.8 matcher and return the report; the §14.8 admin flow surfaces
    // it for line-by-line reconciliation. Mark the queue row accepted.
    if (row.document_type === "commission_statement") {
      const fields = merged as unknown as CommissionStatementFields;
      const report = await matchStatementLineItems({
        tenant_id: ctx.tenant_id,
        statement: fields,
        svc,
      });

      const purgable_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await safeAwait(svc
        .from("import_queue")
        .update({
          status: "accepted",
          accepted_at: new Date().toISOString(),
          accepted_by_user_id: user.id,
          purgable_at,
          // Stash the match report on the row so the §14.8 UI can render it
          // without re-running matching.
          raw_extracted_fields: { ...(merged as object), _match_report: report },
        })
        .eq("id", queueRowId), "import_queue.update");

      await writeAuditLog({
        tenant_id: ctx.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "import.accepted",
        resource_type: "import_queue",
        resource_id: queueRowId,
        context: {
          document_type: "commission_statement",
          total_lines: report.total_lines,
          exact_ref_matches: report.exact_ref_matches,
          fuzzy_matches: report.fuzzy_matches,
          orphans: report.orphans,
        },
      });

      return Response.json({ accepted: true, document_type: "commission_statement", match_report: report });
    }

    const result = await promoteImport({
      queue_row_id: queueRowId,
      svc,
      acceptingUserId: user.id,
    });

    if (!("ok" in result) || !result.ok) {
      if ("needs_review" in result) {
        return Response.json({ error: "still_needs_review", reason: result.reason }, { status: 409 });
      }
      return Response.json({ error: ("error" in result ? result.error : "promote_failed") }, { status: 500 });
    }

    // §34.7.3 step 3 — fix up commission_rate_source when the agent
    // supplied the rate (the promoter's resolver couldn't distinguish
    // agent-edit-on-doc from real doc-parsed).
    if (agentSetRate && result.commission_id) {
      await safeAwait(svc
        .from("commissions")
        .update({ commission_rate_source: "agent_set" })
        .eq("id", result.commission_id), "commissions.update");
    }

    return Response.json({
      accepted: true,
      contact_id: result.contact_id,
      booking_id: result.booking_id,
      commission_id: result.commission_id,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
