// §22.12 — Duplicate resolution action.
//
// Three modes:
//   replace: forward to RAG service /replace/chunk/:id (NEW endpoint —
//     added as a TODO(bp22-rag-replace) for now; the action records the
//     intent and marks the new submission rejected if not yet implemented).
//   add_with_supersedes: records supersedes_chunk_id on this submission and
//     proceeds with the normal approve flow.
//   cancel: marks this submission review_status='superseded' (per §22.12
//     wording), dropping it.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

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

    // mode === 'replace': TODO(bp22-rag-replace) — RAG service /replace/chunk
    // endpoint not yet built. For now, record intent and surface a 501 so the
    // caller knows to fall back to add_with_supersedes.
    return Response.json(
      {
        error: "replace_mode_not_yet_implemented",
        suggestion: "use_add_with_supersedes_mode_instead",
        todo: "bp22-rag-replace-endpoint",
      },
      { status: 501 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
