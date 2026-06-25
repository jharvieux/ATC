// §15.14.3 — Post-termination chunk marking.
// Called by the main app's tenant-on-terminated Inngest function when a tenant is terminated.
export const dynamic = "force-dynamic";
// Updates globally-promoted chunks from the terminated tenant:
//   - voluntary / involuntary_other → reviewed_retained
//   - involuntary_content → pending (all go to post-termination review queue)

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface MarkBody {
  tenant_id: string;
  termination_kind: "voluntary" | "involuntary_content" | "involuntary_other";
  post_termination_review_status: "pending" | "reviewed_retained";
}

export const POST = withServiceAuth(async (req, ctx) => {
  // Require write scope — read-scoped tokens must not mutate (the read|write
  // claim is independent of service_identifier). Mirrors replace-chunk. F-rag-auth-02.
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  // §15.14.3 — Platform-admin only. The 2026-05-25 RAG audit (Finding 4)
  // showed that without this gate, any active tenant JWT could pass
  // another tenant's UUID and mass-mark their global chunks as
  // post-termination — surfacing them in the review queue and (via
  // Finding 2) enabling later mass deletion.
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "post_termination_mark_requires_platform_admin" },
      { status: 403 },
    );
  }

  let body: MarkBody;
  try {
    const raw = await req.json();
    if (!raw.tenant_id || !raw.termination_kind || !raw.post_termination_review_status) {
      throw new Error("missing fields");
    }
    body = raw as MarkBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  // Mark globally-promoted chunks from this tenant.
  // Sets terminated_origin_tenant_id and post_termination_review_status.
  const { data, error } = await db
    .from("knowledge_chunks")
    .update({
      terminated_origin_tenant_id: body.tenant_id,
      post_termination_review_status: body.post_termination_review_status,
    })
    .eq("scope", "global")
    .eq("tenant_id", body.tenant_id)
    .select("id");

  if (error) {
    return dbErrorResponse(error);
  }

  const count = (data ?? []).length;
  console.info(
    "[post-termination-mark] tenant=%s kind=%s status=%s chunks=%d",
    body.tenant_id, body.termination_kind, body.post_termination_review_status, count,
  );

  return Response.json({ ok: true, chunks_marked: count });
});
