// §15.14.4 — List knowledge_chunks pending post-termination review.
// Called by the main app's /api/admin/chunks/post-termination GET handler.
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

export const GET = withServiceAuth(async (req, ctx) => {
  // §15.14.4 — Platform-admin only. The 2026-05-25 RAG audit (Finding 3)
  // showed that without this gate, any active tenant JWT could page
  // through every pending-review chunk across all tenants — exposing
  // content the platform flagged as sensitive enough to gate.
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "post_termination_queue_requires_platform_admin" },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(req.url);
  const from = parseInt(searchParams.get("from") ?? "0", 10);
  const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "20", 10));

  const db = getRagDb();

  const { data, error, count } = await db
    .from("knowledge_chunks")
    // #1190: knowledge_chunks timestamp is ingested_at, not created_at.
    .select(
      "id, content, source_url, source_type, tenant_id, terminated_origin_tenant_id, post_termination_review_status, ingested_at",
      { count: "exact" },
    )
    .eq("post_termination_review_status", "pending")
    .eq("scope", "global")
    .order("ingested_at", { ascending: false })
    .range(from, from + limit - 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ chunks: data ?? [], total: count ?? 0 });
});
