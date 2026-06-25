// §33.12 — List chunks for the authority-override admin UI.
//
// Platform-admin only. Returns a paginated view of knowledge_chunks
// with their authority fields + source metadata, filterable by:
//   - source (cruisemapper / tenant_submission / etc.)
//   - has_override (true → only chunks with an active manual override)
//   - scope (global / tenant / etc.)
//
// The list is intentionally a read-only browse view; mutation goes
// through /api/admin/set-authority-override per chunk.

export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const PAGE_SIZE = 25;

export const GET = withServiceAuth(async (req, ctx) => {
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "list_for_curation_requires_platform_admin" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const sourceFilter = url.searchParams.get("source");
  const scopeFilter = url.searchParams.get("scope");
  const hasOverride = url.searchParams.get("has_override");

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const db = getRagDb();
  let q = db
    .from("knowledge_chunks")
    .select(
      "id, content, source_url, source_type, scope, tenant_id, category, " +
        "authority_auto, authority_manual_override, authority_override_reason, " +
        "authority_override_set_at, ingested_at",
      { count: "exact" },
    )
    .order("ingested_at", { ascending: false })
    .range(from, to);

  if (sourceFilter) q = q.eq("source_type", sourceFilter);
  if (scopeFilter) q = q.eq("scope", scopeFilter);
  if (hasOverride === "true") q = q.not("authority_manual_override", "is", null);
  if (hasOverride === "false") q = q.is("authority_manual_override", null);

  const { data, count, error } = await q;
  if (error) {
    return dbErrorResponse(error);
  }

  return Response.json({
    items: data ?? [],
    page,
    page_size: PAGE_SIZE,
    total: count ?? 0,
  });
});
