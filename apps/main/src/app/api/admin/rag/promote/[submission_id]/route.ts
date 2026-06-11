// §22.8 — Promote a tenant-approved chunk to global scope.
//
// Wrapped in withPlatformAdminAudit with reason='rag_chunk_promotion_to_global'.
// Calls RAG /approve/global with the tenant chunk ID and admin notes.
// On success, inserts rag_global_promotions row and returns global chunk ID.
//
// Per §15.14.3 chunk-license-survival: the origin tenant_id is preserved on
// the global chunk for forensic traceability — it survives the origin
// tenant's termination.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { assertPlatformRole, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

interface Body {
  notes?: string;
  // Which surface triggered the promotion — drives the rag_global_promotions.promotion_source.
  source?: "auto_flagged" | "tenant_suggested" | "admin_browse" | "admin_one_off";
}

interface RagGlobalApproveResponse {
  global_chunk_id?: string;
  error?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ submission_id: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformRole(req, ["superadmin", "reviewer", "service"])).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { submission_id } = await params;
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    // Empty body fine; notes/source default.
  }
  const source = body.source ?? "admin_browse";

  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) return Response.json({ error: "rag_service_not_configured" }, { status: 500 });

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_chunk_promotion_to_global",
        operation: `promote.${source}`,
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "rag_submissions" });

        const { data: sub, error: subErr } = await db
          .from("rag_submissions")
          .select("id, tenant_id, chunk_id_created, review_status")
          .eq("id", submission_id)
          .maybeSingle();
        if (subErr) return { error: subErr.message };
        if (!sub) return { error: "submission_not_found" };

        const row = sub as { id: string; tenant_id: string; chunk_id_created: string | null; review_status: string };
        if (row.review_status !== "approved" || !row.chunk_id_created) {
          return { error: "submission_not_approved_or_no_chunk_id" };
        }

        // BP09 — RS256 JWT, tenant-scoped to the origin tenant (we're
        // promoting one of THIS tenant's chunks).
        const jwt = await signServiceJwt({
          tenant_id: row.tenant_id,
          scope: "write",
          service_identifier: "platform-admin",
        });

        // Call the RAG service to promote.
        const approveRes = await fetch(`${ragUrl}/api/approve/global`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            tenant_chunk_id: row.chunk_id_created,
            origin_tenant_id: row.tenant_id,
            promoted_by_user_id: adminUserId,
            notes: body.notes ?? "",
          }),
        });
        if (!approveRes.ok) {
          const t = await approveRes.text();
          return { error: "rag_approve_global_failed", detail: t };
        }
        const j = (await approveRes.json()) as RagGlobalApproveResponse;
        if (!j.global_chunk_id) {
          return { error: "rag_approve_global_no_id", upstream: j };
        }

        // Insert promotion record.
        recordQuery({ op: "insert", table: "rag_global_promotions" });
        const { data: promo, error: promoErr } = await db
          .from("rag_global_promotions")
          .insert({
            submission_id: row.id,
            tenant_chunk_id: row.chunk_id_created,
            global_chunk_id: j.global_chunk_id,
            promoted_by_user_id: adminUserId,
            promotion_source: source,
            notes: body.notes ?? null,
          })
          .select("id")
          .single();
        if (promoErr) return { error: promoErr.message };

        return {
          promotion_id: (promo as { id: string }).id,
          global_chunk_id: j.global_chunk_id,
        };
      },
    );

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
