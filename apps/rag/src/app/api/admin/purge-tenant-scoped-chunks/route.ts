// §15.14.3 — Purge tenant-scoped chunks for a terminated tenant.
// Called by the daily cron in the main app after 90 days post-termination.
// Only deletes scope='tenant' chunks. Globally-promoted chunks are NEVER auto-deleted.
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface PurgeBody {
  tenant_id: string;
}

export const POST = withServiceAuth(async (req, ctx) => {
  // §15.14.3 — Platform-admin only. The 2026-05-25 RAG audit (Finding 1)
  // showed that without this gate, any active tenant JWT could pass
  // body.tenant_id pointing at a victim tenant and physically delete
  // every one of their tenant-scoped chunks. Mass cross-tenant data
  // destruction in one request.
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "purge_tenant_scoped_chunks_requires_platform_admin" },
      { status: 403 },
    );
  }

  let body: PurgeBody;
  try {
    const raw = await req.json();
    if (!raw.tenant_id) throw new Error("missing tenant_id");
    body = raw as PurgeBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  const { data, error } = await db
    .from("knowledge_chunks")
    .delete()
    .eq("scope", "tenant")
    .eq("tenant_id", body.tenant_id)
    .select("id");

  if (error) {
    console.error("[purge-tenant-scoped-chunks] delete failed: %s", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const count = (data ?? []).length;
  console.info("[purge-tenant-scoped-chunks] tenant=%s deleted=%d tenant-scoped chunks", body.tenant_id, count);

  return Response.json({ ok: true, chunks_deleted: count });
});
