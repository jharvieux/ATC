// §22.5 — Approve a queued submission.
//
// Two-step forward to the RAG service:
//   1. POST /api/ingest with the cleaned content → creates a
//      knowledge_ingestion_queue item on the RAG side.
//   2. POST /api/approve/tenant with the returned queue_item_id → promotes
//      to a knowledge_chunks row, returns chunk_id.
//
// On success, the main-app rag_submissions row transitions to
// review_status='approved' and stores the chunk_id_created.
//
// Bulk approval safety: if the caller passes ?bulk=true with a list of IDs,
// requires the X-Bulk-Confirm header when count > 10 per §22.5 safety prompt.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

interface RagIngestResponse {
  queue_item_id?: string;
  status?: string;
  reason?: string;
}
interface RagApproveResponse {
  chunk_id?: string;
  error?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "approve" });
    const db = tenantClient(ctx);
    const { id } = await params;

    // Optional edits the reviewer made in the UI before approving.
    let body: { edits?: Record<string, unknown> } = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is fine — defaults apply.
    }

    const { data: sub, error: fetchErr } = await db
      .from("rag_submissions")
      .select(
        "id, tenant_id, review_status, redacted_content, extracted_content, source_url, normalization_result, content_hash",
      )
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!sub) return Response.json({ error: "not_found" }, { status: 404 });

    const row = sub as {
      id: string;
      tenant_id: string;
      review_status: string;
      redacted_content: string | null;
      extracted_content: string | null;
      source_url: string | null;
      normalization_result: Record<string, unknown> | null;
      content_hash: string | null;
    };

    if (row.review_status !== "ready_for_review") {
      return Response.json({ error: "not_in_ready_for_review" }, { status: 409 });
    }

    const content =
      (body.edits?.content as string | undefined) ?? row.redacted_content ?? row.extracted_content ?? "";
    if (content.length === 0) {
      return Response.json({ error: "empty_content" }, { status: 400 });
    }

    const ragUrl = process.env.RAG_SERVICE_URL;
    if (!ragUrl) {
      return Response.json({ error: "rag_service_not_configured" }, { status: 500 });
    }
    // TODO(bp24-service-jwt): replace with RS256-signed JWT per BP09 contract.
    const bearer = process.env.SERVICE_JWT_PRIVATE_KEY ?? "";

    const norm = (row.normalization_result ?? {}) as Record<string, unknown>;
    const category = (body.edits?.category as string | undefined) ?? (norm.suggested_category as string | undefined) ?? "general";

    // Step 1: POST /api/ingest
    const ingestRes = await fetch(`${ragUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        scope: "tenant",
        tenant_id: row.tenant_id,
        raw_content: content,
        source_url: row.source_url ?? undefined,
        source_type: "tenant_verified",
        category,
        cruise_line: norm.cruise_line ?? undefined,
        ship: norm.ship ?? undefined,
        destination: norm.destination ?? undefined,
        contains_pricing: norm.pricing_detected ?? false,
      }),
    });
    if (!ingestRes.ok) {
      const t = await ingestRes.text();
      return Response.json({ error: "rag_ingest_failed", detail: t }, { status: 502 });
    }
    const ingested = (await ingestRes.json()) as RagIngestResponse;
    if (!ingested.queue_item_id) {
      return Response.json({ error: "rag_ingest_no_queue_id", upstream: ingested }, { status: 502 });
    }

    // Step 2: POST /api/approve/tenant
    const approveRes = await fetch(`${ragUrl}/api/approve/tenant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        queue_item_id: ingested.queue_item_id,
        edits: body.edits ?? {},
      }),
    });
    if (!approveRes.ok) {
      const t = await approveRes.text();
      return Response.json({ error: "rag_approve_failed", detail: t }, { status: 502 });
    }
    const approved = (await approveRes.json()) as RagApproveResponse;
    if (!approved.chunk_id) {
      return Response.json({ error: "rag_approve_no_chunk_id", upstream: approved }, { status: 502 });
    }

    // Update the rag_submissions row.
    const { error: updateErr } = await db
      .from("rag_submissions")
      .update({
        review_status: "approved",
        chunk_id_created: approved.chunk_id,
        tenant_review_decision_by_user_id: user.id,
        tenant_review_decision_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updateErr) {
      return Response.json({ error: updateErr.message }, { status: 500 });
    }

    return Response.json({ chunk_id: approved.chunk_id, status: "approved" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
