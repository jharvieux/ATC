// §17.9 — CCPA data export hand-off.
// Called by the main app's user-data-export-build Inngest job. Returns
// every knowledge_chunks row submitted by the requesting user (matched
// on ingest_user_id, added by migration 0009).
//
// Platform-admin only — the JWT identifies the calling service, not the
// end user whose data is being exported. The main app verifies user
// identity before invoking this; this endpoint is just the data-plane
// fetch.
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface ExportBody {
  auth_user_id: string;
}

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json(
      { error: "export_user_chunks_requires_platform_admin" },
      { status: 403 },
    );
  }

  let body: ExportBody;
  try {
    const raw = await req.json();
    if (!raw.auth_user_id) throw new Error("missing auth_user_id");
    body = raw as ExportBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  const { data, error } = await db
    .from("knowledge_chunks")
    // #1190: knowledge_chunks has no source_title/created_at — the provenance
    // fields are source_type/source_url and the timestamp is ingested_at.
    .select("id, scope, tenant_id, source_url, source_type, category, content, ingested_at")
    .eq("ingest_user_id", body.auth_user_id);

  if (error) {
    return dbErrorResponse(error);
  }

  return Response.json({ ok: true, chunks: data ?? [] });
});
