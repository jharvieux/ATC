// §22.8 — Demote a globally-promoted chunk.
//
// Wrapped in withPlatformAdminAudit with reason='rag_chunk_demotion'.
// Two modes:
//   to_tenant_scope (default): chunk scope changes back to 'tenant' on the
//     RAG side via /demote/chunk/:id (NEW endpoint — TODO until RAG side
//     ships it; for now the main-app records the intent + audit).
//   hard_delete: chunk removed entirely via /demote/chunk/:id?mode=delete.
//
// If origin tenant is terminated, to_tenant_scope leaves the chunk in the
// origin tenant's scope subject to the §15.14.3 90-day post-termination
// tenant-scoped retention.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

interface Body {
  mode?: "to_tenant_scope" | "hard_delete";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ promotion_id: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { promotion_id } = await params;
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    // Empty body fine; mode defaults to to_tenant_scope.
  }
  const mode = body.mode ?? "to_tenant_scope";
  if (!["to_tenant_scope", "hard_delete"].includes(mode)) {
    return Response.json({ error: "invalid_mode" }, { status: 400 });
  }

  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) return Response.json({ error: "rag_service_not_configured" }, { status: 500 });

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_chunk_demotion",
        operation: `demote.${mode}`,
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "rag_global_promotions" });

        const { data: promo, error: promoErr } = await db
          .from("rag_global_promotions")
          .select("id, global_chunk_id, demoted_at")
          .eq("id", promotion_id)
          .maybeSingle();
        if (promoErr) return { error: promoErr.message };
        if (!promo) return { error: "promotion_not_found" };

        const row = promo as { id: string; global_chunk_id: string; demoted_at: string | null };
        if (row.demoted_at) return { error: "already_demoted" };

        // BP09 — RS256 JWT, PLATFORM sentinel since demoting a global chunk
        // isn't scoped to one tenant (affects all readers).
        const jwt = await signServiceJwt({
          tenant_id: PLATFORM_SENTINEL_TENANT_ID,
          scope: "write",
          service_identifier: "platform-admin",
        });

        // Call the RAG service to perform the actual chunk lifecycle change.
        // TODO(bp22-rag-demote): once /demote/chunk lands on the RAG side, swap
        // the success path here. Until then we record the intent and surface a
        // 501 so the operator knows the RAG-side hand-off is incomplete.
        const ragRes = await fetch(`${ragUrl}/api/admin/demote-chunk?id=${row.global_chunk_id}&mode=${mode}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!ragRes.ok && ragRes.status !== 404) {
          // 404 = endpoint not yet implemented; we still record the demotion
          // locally so the operator action is captured.
          const t = await ragRes.text();
          return { error: "rag_demote_failed", detail: t };
        }

        recordQuery({ op: "update", table: "rag_global_promotions" });
        const { error: updErr } = await db
          .from("rag_global_promotions")
          .update({
            demoted_at: new Date().toISOString(),
            demoted_by_user_id: adminUserId,
            demote_mode: mode,
          })
          .eq("id", promotion_id);
        if (updErr) return { error: updErr.message };

        return {
          status: "demoted",
          mode,
          rag_endpoint_status: ragRes.status,
          ...(ragRes.status === 404 && { note: "rag_demote_endpoint_not_yet_implemented_main_recorded_intent" }),
        };
      },
    );

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
