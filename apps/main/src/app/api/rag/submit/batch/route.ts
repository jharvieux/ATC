// §22.1 — Batch API submission endpoint (service-token auth).
//
// Accepts a JSON array of up to 100 items. Atomic: any item validation
// failure aborts the entire batch (returns 400 before any insert). Inserts
// the rows in a single transaction-like sequence, then fires one Inngest
// event per row.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface Item {
  content: string;
  source_url?: string;
  source_title?: string;
}

const MAX_ITEMS = 100;

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "create" });
    const db = tenantClient(ctx);

    let items: Item[];
    try {
      const body = (await req.json()) as { items?: Item[] };
      if (!Array.isArray(body.items)) {
        return Response.json({ error: "items_array_required" }, { status: 400 });
      }
      items = body.items;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (items.length === 0) {
      return Response.json({ error: "items_empty" }, { status: 400 });
    }
    if (items.length > MAX_ITEMS) {
      return Response.json({ error: "too_many_items", max: MAX_ITEMS }, { status: 400 });
    }

    // Validate all up front.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it?.content || it.content.trim().length === 0) {
        return Response.json({ error: `item_${i}_missing_content` }, { status: 400 });
      }
    }

    // Insert all (Supabase doesn't expose explicit transactions; the batch
    // insert is atomic per single-statement).
    const rows = items.map((it) => ({
      tenant_id: ctx.tenant_id,
      submitted_by_user_id: user.id,
      submission_method: "batch_api",
      source_url: it.source_url ?? null,
      source_title: it.source_title ?? null,
      original_content: it.content,
      extraction_status: "extracted",
      extracted_content: it.content,
    }));

    const { data, error } = await db
      .from("rag_submissions")
      .insert(rows)
      .select("id");
    if (error) return dbErrorResponse(error);

    const ids = (data as Array<{ id: string }>).map((r) => r.id);
    await Promise.all(
      ids.map((submission_id) =>
        inngest.send({
          name: "rag.submission_ready_for_pii_redaction",
          data: { submission_id, tenant_id: ctx.tenant_id },
        }),
      ),
    );

    return Response.json({ submission_ids: ids, count: ids.length });
  } catch (err) {
    return respondToAuthError(err);
  }
}
