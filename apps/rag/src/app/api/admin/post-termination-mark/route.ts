// §15.14.3 — Post-termination chunk marking.
// Called by the main app's tenant-on-terminated Inngest function when a tenant is terminated.
export const dynamic = "force-dynamic";
// Updates globally-promoted chunks from the terminated tenant:
//   - voluntary / involuntary_other → reviewed_retained
//   - involuntary_content → pending (all go to post-termination review queue)

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface MarkBody {
  tenant_id: string;
  termination_kind: "voluntary" | "involuntary_content" | "involuntary_other";
  post_termination_review_status: "pending" | "reviewed_retained";
}

export const POST = withServiceAuth(async (req) => {
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
    console.error("[post-termination-mark] update failed: %s", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const count = (data ?? []).length;
  console.info(
    "[post-termination-mark] tenant=%s kind=%s status=%s chunks=%d",
    body.tenant_id, body.termination_kind, body.post_termination_review_status, count,
  );

  return Response.json({ ok: true, chunks_marked: count });
});
