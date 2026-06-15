// §22.7 — Four-tab global review queue.
//
// Roles: platform_super_admin, platform_compliance. Wrapped in
// withPlatformAdminAudit for cross-tenant reads.
//
// Tabs:
//   1. auto_flagged    — auto_flagged_for_global=TRUE, approved, not yet promoted
//   2. tenant_promoted — tenant_suggested_for_global=TRUE, approved
//   3. all_approved    — approved tenant chunks with global_relevance_score
//                        in [0.3, auto-flag threshold)
//   4. likely_specific — approved tenant chunks with score < 0.3 (loads only
//                        on explicit search per spec; query=true required)
//
// Tab passed via ?tab=auto_flagged|tenant_promoted|all_approved|likely_specific.
// Pagination via ?page=N.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

const PAGE_SIZE = 25;

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "rag")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") ?? "auto_flagged";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const autoFlagThreshold = Number(process.env.RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD ?? 0.6);

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_quarantined_content_review",
        operation: `global_review.list.${tab}`,
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "rag_submissions" });

        let q = db
          .from("rag_submissions")
          .select(
            "id, tenant_id, source_url, source_title, redacted_content, extracted_content, normalization_result, content_hash, chunk_id_created, created_at",
            { count: "exact" },
          )
          .eq("review_status", "approved");

        switch (tab) {
          case "auto_flagged":
            q = q.eq("auto_flagged_for_global", true);
            // Exclude items already promoted.
            // (Filter applied via a join-less subquery — see below post-filter.)
            break;
          case "tenant_promoted":
            q = q.eq("tenant_suggested_for_global", true);
            break;
          case "all_approved":
            q = q
              .gte("normalization_result->>global_relevance_score", "0.3")
              .lt("normalization_result->>global_relevance_score", String(autoFlagThreshold));
            break;
          case "likely_specific":
            // Largest tab — require search param to avoid full-table scans.
            if (!url.searchParams.get("q")) {
              return { items: [], total: 0, requires_search: true };
            }
            q = q.lt("normalization_result->>global_relevance_score", "0.3");
            break;
          default:
            return { error: "invalid_tab" };
        }

        q = q.order("created_at", { ascending: false }).range(from, to);
        const { data, count, error } = await q;
        if (error) return { error: error.message };

        let items = (data ?? []) as Array<{ id: string; chunk_id_created: string | null }>;

        // For auto_flagged, exclude items already promoted.
        if (tab === "auto_flagged" && items.length > 0) {
          const chunkIds = items.map((i) => i.chunk_id_created).filter((c): c is string => !!c);
          if (chunkIds.length > 0) {
            const { data: promotedIds } = await db
              .from("rag_global_promotions")
              .select("tenant_chunk_id")
              .in("tenant_chunk_id", chunkIds)
              .is("demoted_at", null);
            const promoted = new Set((promotedIds ?? []).map((r: { tenant_chunk_id: string }) => r.tenant_chunk_id));
            items = items.filter((i) => !i.chunk_id_created || !promoted.has(i.chunk_id_created));
          }
        }

        return { items, total: count ?? items.length, page, page_size: PAGE_SIZE };
      },
    );

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
