// §22.12 — Duplicate detection lookup.
//
// Given a rag_submissions row, returns any prior approved submission within
// the same tenant whose content_hash matches. The UI surfaces three options:
//   replace: call /api/rag/queue/:id/duplicate-action with mode='replace'
//   add_with_supersedes: mode='add_with_supersedes'
//   cancel: mode='cancel'
//
// The companion action endpoint lands alongside this one (see
// /api/rag/queue/[id]/duplicate-action/route.ts).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "rag_submissions", action: "review" });
    const db = tenantClient(ctx);
    const { id } = await params;

    const { data: cur, error: curErr } = await db
      .from("rag_submissions")
      .select("content_hash")
      .eq("id", id)
      .maybeSingle();
    if (curErr) return Response.json({ error: curErr.message }, { status: 500 });
    if (!cur) return Response.json({ error: "not_found" }, { status: 404 });

    const hash = (cur as { content_hash: string | null }).content_hash;
    if (!hash) {
      return Response.json({ duplicate: false, reason: "no_content_hash_yet" });
    }

    const { data: matches, error: matchErr } = await db
      .from("rag_submissions")
      .select("id, chunk_id_created, source_title, source_url, created_at")
      .eq("content_hash", hash)
      .eq("review_status", "approved")
      .neq("id", id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (matchErr) return Response.json({ error: matchErr.message }, { status: 500 });

    const list = (matches ?? []) as Array<{
      id: string;
      chunk_id_created: string | null;
      source_title: string | null;
      source_url: string | null;
      created_at: string;
    }>;

    if (list.length === 0) {
      return Response.json({ duplicate: false });
    }

    return Response.json({
      duplicate: true,
      existing: list,
      actions: ["replace", "add_with_supersedes", "cancel"],
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
