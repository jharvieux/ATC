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
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

interface CountRow {
  tenant_id: string;
  count: number;
}

// #1787 — up to 1000 tenant_ids per call; bounded concurrency turns a
// worst-case 1000 sequential round-trips into ~1000/20 batches without
// hammering the DB with an unbounded fan-out.
const COUNT_CONCURRENCY = 20;

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
  //
  // #1787 — up to 1000 tenant_ids; bounded-concurrency fan out instead of
  // one round-trip at a time. Each query is independent (different
  // tenant_id), so per-tenant skip-on-error isolation is unaffected.
  const rows = await mapWithConcurrency(ids, COUNT_CONCURRENCY, async (tenant_id) => {
    const { count, error } = await db
      .from("knowledge_chunks")
      .select("*", { count: "exact", head: true })
      .eq("scope", "tenant")
      .eq("tenant_id", tenant_id)
      .eq("status", "approved")
      .is("superseded_by_chunk_id", null);
    if (error) {
      console.error("[admin/tenant-chunk-counts] read failed for tenant=%s: %s", tenant_id, error.message);
      // Skip this tenant rather than fail the whole batch; caller can detect
      // missing rows by intersecting requested ids vs returned ids.
      return null;
    }
    return { tenant_id, count: count ?? 0 };
  });
  const counts: CountRow[] = rows.filter((r): r is CountRow => r !== null);

  return Response.json({ counts });
});
