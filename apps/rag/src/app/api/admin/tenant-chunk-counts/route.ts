// Pre-go-live wire-up — Returns per-tenant counts of approved knowledge_chunks
// for the abuse-recompute-nightly cron in main. Resolves the
// TODO(rag-service-count) at apps/main/src/inngest/abuse-recompute-nightly.ts
// so the SaaS abuse dashboard's `current_tenant_chunks_count` reflects reality.
//
// Caller MUST be platform-admin (service JWT with service_identifier =
// 'platform-admin'). This endpoint reads across tenants; the per-tenant JWT
// path can't reach it.

export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface CountRow {
  tenant_id: string;
  count: number;
}

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "read" && ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json({ error: "platform_admin_only" }, { status: 403 });
  }

  let body: { tenant_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const ids = Array.isArray(body.tenant_ids)
    ? body.tenant_ids.filter((x): x is string => typeof x === "string")
    : null;
  if (!ids || ids.length === 0) {
    return Response.json({ counts: [] satisfies CountRow[] });
  }
  if (ids.length > 1000) {
    return Response.json({ error: "too_many_tenant_ids", limit: 1000 }, { status: 400 });
  }

  const db = getRagDb();

  // Per-tenant count of approved, non-superseded, tenant-scope chunks.
  // Global-scope chunks aren't tenant-attributable and are excluded here —
  // tenant_rag_quotas tracks each tenant's own chunk budget, not platform-wide.
  const counts: CountRow[] = [];
  for (const tenant_id of ids) {
    const { count, error } = await db
      .from("knowledge_chunks")
      .select("*", { count: "exact", head: true })
      .eq("scope", "tenant")
      .eq("tenant_id", tenant_id)
      .eq("status", "approved")
      .is("superseded_by_chunk_id", null);
    if (error) {
      console.error("[admin/tenant-chunk-counts] read failed", { tenant_id, error: error.message });
      // Skip this tenant rather than fail the whole batch; caller can detect
      // missing rows by intersecting requested ids vs returned ids.
      continue;
    }
    counts.push({ tenant_id, count: count ?? 0 });
  }

  return Response.json({ counts });
});
