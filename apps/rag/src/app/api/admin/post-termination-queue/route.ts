// §15.14.4 — List knowledge_chunks pending post-termination review.
// Called by the main app's /api/admin/chunks/post-termination GET handler.

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

export const GET = withServiceAuth(async (req) => {
  const { searchParams } = new URL(req.url);
  const from = parseInt(searchParams.get("from") ?? "0", 10);
  const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "20", 10));

  const db = getRagDb();

  const { data, error, count } = await db
    .from("knowledge_chunks")
    .select(
      "id, content, source_url, source_type, tenant_id, terminated_origin_tenant_id, post_termination_review_status, created_at",
      { count: "exact" },
    )
    .eq("post_termination_review_status", "pending")
    .eq("scope", "global")
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ chunks: data ?? [], total: count ?? 0 });
});
