// §15.14.4 — Apply a review action to a post-termination chunk.
// Actions: retain | demote | hard_delete
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface ReviewBody {
  chunk_id: string;
  action: "retain" | "demote" | "hard_delete";
}

const STATUS_MAP: Record<string, string> = {
  retain: "reviewed_retained",
  demote: "reviewed_demoted",
  hard_delete: "reviewed_hard_deleted",
};

export const POST = withServiceAuth(async (req, ctx) => {
  // §15.14.4 — Platform-admin only. The 2026-05-25 RAG audit (Finding 2)
  // showed that without this gate, any active tenant JWT could hard-delete
  // arbitrary chunks (including global ones) by id, or demote+purge them.
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "post_termination_review_requires_platform_admin" },
      { status: 403 },
    );
  }

  let body: ReviewBody;
  try {
    const raw = await req.json();
    if (!raw.chunk_id || !["retain", "demote", "hard_delete"].includes(raw.action)) {
      throw new Error("invalid fields");
    }
    body = raw as ReviewBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();
  const newStatus = STATUS_MAP[body.action];

  // Defense-in-depth: only act on chunks legitimately in the review queue
  // (post_termination_review_status='pending'). Audit Finding 2 recommended
  // this so even a future bypass of the platform-admin gate can't reach
  // arbitrary chunks.
  if (body.action === "hard_delete") {
    const { error } = await db
      .from("knowledge_chunks")
      .delete()
      .eq("id", body.chunk_id)
      .eq("post_termination_review_status", "pending");
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, action: "hard_delete", chunk_id: body.chunk_id });
  }

  if (body.action === "demote") {
    const { error } = await db
      .from("knowledge_chunks")
      .update({ scope: "tenant", post_termination_review_status: newStatus })
      .eq("id", body.chunk_id)
      .eq("post_termination_review_status", "pending");
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, action: "demote", chunk_id: body.chunk_id });
  }

  // retain — just update the status.
  const { error } = await db
    .from("knowledge_chunks")
    .update({ post_termination_review_status: newStatus })
    .eq("id", body.chunk_id)
    .eq("post_termination_review_status", "pending");

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, action: "retain", chunk_id: body.chunk_id });
});
