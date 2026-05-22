// §22.5 — Bulk approval with safety prompt.
//
// Accepts { submission_ids: string[] }. When count > 10, requires the header
// X-Bulk-Confirm: yes to proceed. Per-item failures are collected and
// returned in the response so the UI can surface a partial-success summary.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const BULK_THRESHOLD = 10;

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "rag_submissions", action: "approve" });
    const db = tenantClient(ctx);
    let body: { submission_ids?: string[] };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const ids = Array.isArray(body.submission_ids) ? body.submission_ids.filter((s) => typeof s === "string") : [];
    if (ids.length === 0) {
      return Response.json({ error: "no_ids" }, { status: 400 });
    }

    if (ids.length > BULK_THRESHOLD) {
      const confirm = req.headers.get("x-bulk-confirm");
      if (confirm !== "yes") {
        return Response.json(
          {
            error: "bulk_confirm_required",
            count: ids.length,
            message: `You are about to approve ${ids.length} items. Send header 'X-Bulk-Confirm: yes' to proceed.`,
          },
          { status: 428 },
        );
      }
    }

    // The individual approve call orchestrates the RAG calls, audit, and
    // status transition. Loop with per-item error capture (sequential to
    // avoid hammering the RAG service with parallel JWT calls).
    const results: Array<{ id: string; ok: boolean; chunk_id?: string; error?: string }> = [];
    for (const id of ids) {
      const res = await fetch(new URL(req.url).origin + `/api/rag/queue/${id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Propagate the same auth header so the per-item handler runs in
          // the same tenant context.
          ...(req.headers.get("authorization") ? { Authorization: req.headers.get("authorization") as string } : {}),
          ...(req.headers.get("cookie") ? { Cookie: req.headers.get("cookie") as string } : {}),
        },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const j = (await res.json()) as { chunk_id?: string };
        results.push({ id, ok: true, ...(j.chunk_id !== undefined && { chunk_id: j.chunk_id }) });
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        results.push({ id, ok: false, error: j.error ?? `status_${res.status}` });
      }
    }

    void db; // Used by the per-item handler via assertPermission; nothing else here.
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    return Response.json({ succeeded, failed, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
