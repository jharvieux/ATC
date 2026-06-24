// §33.12 — Authority override for knowledge_chunks.
//
// Platform-admin only. Sets authority_manual_override + records the reason
// in a new column authority_override_reason (added in companion migration
// 0018). The override takes effect on the next retrieval (the existing
// COALESCE(manual_override, auto) in match_knowledge_chunks reads it
// directly per §6.10 schema).
//
// Pass authority_manual_override=null to CLEAR the override and revert to
// authority_auto.
//
// Called by the main app's /api/admin/rag/authority/[chunk_id] route
// under platform-admin authority.

export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";

interface Body {
  authority_manual_override: number | null;
  reason: string;
}

export const POST = withServiceAuth(async (req, ctx) => {
  // Require write scope — read-scoped tokens must not mutate (the read|write
  // claim is independent of service_identifier). Mirrors replace-chunk. F-rag-auth-02.
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "authority_override_requires_platform_admin" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "missing_id" }, { status: 400 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const newOverride = body.authority_manual_override;
  if (newOverride !== null) {
    if (typeof newOverride !== "number" || newOverride < 0 || newOverride > 1) {
      return Response.json(
        { error: "authority_manual_override_out_of_range", detail: "must be null or a number in [0, 1]" },
        { status: 422 },
      );
    }
  }

  const reason = (body.reason ?? "").trim().slice(0, 500);
  if (!reason && newOverride !== null) {
    return Response.json(
      { error: "reason_required_when_setting_override" },
      { status: 422 },
    );
  }

  const db = getRagDb();
  const { data, error } = await db
    .from("knowledge_chunks")
    .update({
      authority_manual_override: newOverride,
      authority_override_reason: newOverride === null ? null : reason,
      authority_override_set_at: newOverride === null ? null : new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, authority_auto, authority_manual_override, authority_override_reason")
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "chunk_not_found" }, { status: 404 });
  }

  return Response.json({
    ok: true,
    chunk: data,
  });
});
