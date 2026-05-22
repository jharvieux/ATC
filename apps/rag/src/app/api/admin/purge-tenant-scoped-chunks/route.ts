// §15.14.3 — Purge tenant-scoped chunks for a terminated tenant.
// Called by the daily cron in the main app after 90 days post-termination.
// Only deletes scope='tenant' chunks. Globally-promoted chunks are NEVER auto-deleted.

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface PurgeBody {
  tenant_id: string;
}

export const POST = withServiceAuth(async (req) => {
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
