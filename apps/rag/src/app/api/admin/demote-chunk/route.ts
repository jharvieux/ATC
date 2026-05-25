// §22.8 — Demote a globally-promoted chunk.
// Called by the main app's /api/admin/rag/demote/[promotion_id] route under
// platform-admin authority. Two modes:
//
//   ?mode=to_tenant_scope (default) — chunk scope changes back to 'tenant'.
//     The origin tenant retains the chunk (subject to the §15.14.3 90-day
//     post-termination tenant-scoped retention if they were terminated).
//
//   ?mode=hard_delete — chunk row is physically deleted.
//
// In both modes the chunk is no longer surfaced to global retrieval. The
// main side records the audit row + flips rag_global_promotions.demoted_at
// independently; this endpoint is purely the data-plane mutation.
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

type DemoteMode = "to_tenant_scope" | "hard_delete";

export const POST = withServiceAuth(async (req, ctx) => {
  // Platform-admin only — demoting a global chunk affects every tenant
  // that was reading it, so this MUST never be reachable from a tenant
  // JWT. Same posture as purge-tenant-scoped-chunks + post-termination-mark.
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "demote_chunk_requires_platform_admin" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const modeParam = url.searchParams.get("mode") ?? "to_tenant_scope";
  if (!id) {
    return Response.json({ error: "missing_id" }, { status: 400 });
  }
  if (modeParam !== "to_tenant_scope" && modeParam !== "hard_delete") {
    return Response.json({ error: "invalid_mode" }, { status: 400 });
  }
  const mode = modeParam as DemoteMode;

  const db = getRagDb();

  if (mode === "hard_delete") {
    const { data, error } = await db
      .from("knowledge_chunks")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      console.error("[demote-chunk] hard_delete failed: %s", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }
    if ((data ?? []).length === 0) {
      return Response.json({ error: "chunk_not_found" }, { status: 404 });
    }
    console.info("[demote-chunk] hard_delete chunk=%s", id);
    return Response.json({ ok: true, mode, chunk_id: id });
  }

  // to_tenant_scope — flip scope back to 'tenant' so the chunk is no longer
  // visible to global retrieval, but the origin tenant still sees it.
  const { data, error } = await db
    .from("knowledge_chunks")
    .update({ scope: "tenant" })
    .eq("id", id)
    .eq("scope", "global")
    .select("id");
  if (error) {
    console.error("[demote-chunk] to_tenant_scope update failed: %s", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if ((data ?? []).length === 0) {
    return Response.json({ error: "chunk_not_found_or_not_global" }, { status: 404 });
  }
  console.info("[demote-chunk] to_tenant_scope chunk=%s", id);
  return Response.json({ ok: true, mode, chunk_id: id });
});
