// §22.12 — Duplicate resolution action.
//
// Three modes:
//   replace: forward to RAG service /api/admin/replace-chunk to swap the
//     existing chunk's content with the new submission's cleaned content,
//     then mark the new submission rejected (its content now lives on the
//     existing chunk_id).
//   add_with_supersedes: records supersedes_chunk_id on this submission and
//     proceeds with the normal approve flow.
//   cancel: marks this submission review_status='superseded' (per §22.12
//     wording), dropping it.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";

interface Body {
  mode: "replace" | "add_with_supersedes" | "cancel";
  target_chunk_id?: string; // required for replace and add_with_supersedes
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "approve" });
    const db = tenantClient(ctx);
    const { id } = await params;

    let body: Body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!["replace", "add_with_supersedes", "cancel"].includes(body.mode)) {
      return Response.json({ error: "invalid_mode" }, { status: 400 });
    }

    if (body.mode === "cancel") {
      const { error } = await db
        .from("rag_submissions")
        .update({
          review_status: "superseded",
          tenant_review_decision_by_user_id: user.id,
          tenant_review_decision_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("review_status", "ready_for_review");
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ status: "superseded" });
    }

    if (!body.target_chunk_id) {
      return Response.json({ error: "target_chunk_id_required" }, { status: 400 });
    }

    if (body.mode === "add_with_supersedes") {
      // Record the supersedes link; the normal approve flow handles the rest.
      const { error } = await db
        .from("rag_submissions")
        .update({
          supersedes_chunk_id: body.target_chunk_id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({
        status: "supersedes_recorded",
        next: `POST /api/rag/queue/${id}/approve to complete approval`,
      });
    }

    // mode === 'replace' — swap target chunk's content with this submission's
    // cleaned content via the RAG side, then mark this submission rejected
    // (its content lives on the original chunk_id now).
    const { data: sub, error: fetchErr } = await db
      .from("rag_submissions")
      .select("id, tenant_id, redacted_content, extracted_content, source_url, normalization_result")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!sub) return Response.json({ error: "not_found" }, { status: 404 });

    const row = sub as {
      id: string;
      tenant_id: string;
      redacted_content: string | null;
      extracted_content: string | null;
      source_url: string | null;
      normalization_result: Record<string, unknown> | null;
    };
    const content = (row.redacted_content ?? row.extracted_content ?? "").trim();
    if (content.length === 0) {
      return Response.json({ error: "empty_content" }, { status: 400 });
    }

    const ragUrl = process.env.RAG_SERVICE_URL;
    if (!ragUrl) {
      return Response.json({ error: "rag_service_not_configured" }, { status: 500 });
    }

    const jwt = await signServiceJwt({
      tenant_id: row.tenant_id,
      scope: "write",
      service_identifier: "chat-service",
    });
    const norm = (row.normalization_result ?? {}) as Record<string, unknown>;
    const category = typeof norm.suggested_category === "string" ? norm.suggested_category : undefined;

    const ragRes = await fetch(`${ragUrl}/api/admin/replace-chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        chunk_id: body.target_chunk_id,
        content,
        source_url: row.source_url,
        ...(category ? { category } : {}),
      }),
    });
    if (!ragRes.ok) {
      const detail = await ragRes.text();
      return Response.json(
        { error: "rag_replace_failed", rag_status: ragRes.status, detail },
        { status: 502 },
      );
    }

    const { error: updErr } = await db
      .from("rag_submissions")
      .update({
        review_status: "superseded",
        tenant_review_decision_by_user_id: user.id,
        tenant_review_decision_at: new Date().toISOString(),
        supersedes_chunk_id: body.target_chunk_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updErr) return Response.json({ error: updErr.message }, { status: 500 });

    return Response.json({ status: "replaced", target_chunk_id: body.target_chunk_id });
  } catch (err) {
    return respondToAuthError(err);
  }
}
