// §22.5 — Tenant review queue list endpoint.
// Returns paginated rag_submissions rows in review_status='ready_for_review',
// with the AI-normalized metadata for each.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const PAGE_SIZE = 25;

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "rag_submissions", action: "review" });
    const db = tenantClient(ctx);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const category = url.searchParams.get("category");
    const sourceType = url.searchParams.get("source_type");

    let q = db
      .from("rag_submissions")
      .select(
        "id, submission_method, source_url, source_title, extracted_content, redacted_content, normalization_result, pii_redaction_status, auto_flagged_for_global, content_hash, created_at",
        { count: "exact" },
      )
      .eq("review_status", "ready_for_review")
      .order("created_at", { ascending: false })
      .range(from, to);

    if (category) q = q.eq("normalization_result->>suggested_category", category);
    if (sourceType) q = q.eq("submission_method", sourceType);

    const { data, count, error } = await q;
    if (error) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    return Response.json({
      items: data ?? [],
      page,
      page_size: PAGE_SIZE,
      total: count ?? 0,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
