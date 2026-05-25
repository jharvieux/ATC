// §22.12 — Replace a chunk's content in place.
// Called by the main app's duplicate-action 'replace' mode when a reviewer
// decides a new submission supersedes an existing chunk's content.
//
// In-place update preserves chunk_id (so any references stay valid) and
// re-embeds the new content. Re-runs the zero-tolerance PII pre-filter
// since the new content hasn't been through the ingest flow.
//
// Auth posture mirrors the chunk's scope:
//   tenant chunks → JWT must carry that tenant's tenant_id
//   global chunks → service_identifier must be 'platform-admin'
export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embed } from "@/lib/embeddings/openai";
import { detectZeroTolerancePII } from "@/lib/pii/regex-prefilter";

interface ReplaceBody {
  chunk_id: string;
  content: string;
  source_url?: string | null;
  category?: string | null;
}

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  let body: ReplaceBody;
  try {
    const raw = await req.json();
    if (!raw.chunk_id || typeof raw.chunk_id !== "string") {
      throw new Error("missing chunk_id");
    }
    if (!raw.content || typeof raw.content !== "string" || raw.content.trim().length === 0) {
      throw new Error("missing content");
    }
    body = raw as ReplaceBody;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getRagDb();

  const { data: existing, error: fetchErr } = await db
    .from("knowledge_chunks")
    .select("id, scope, tenant_id")
    .eq("id", body.chunk_id)
    .maybeSingle();
  if (fetchErr) {
    console.error("[replace-chunk] fetch failed: %s", fetchErr.message);
    return Response.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!existing) {
    return Response.json({ error: "chunk_not_found" }, { status: 404 });
  }
  const chunk = existing as { id: string; scope: "tenant" | "global"; tenant_id: string | null };

  // Scope-aware auth.
  if (chunk.scope === "global") {
    if (ctx.service_identifier !== "platform-admin") {
      return Response.json(
        { error: "replace_global_chunk_requires_platform_admin" },
        { status: 403 },
      );
    }
  } else {
    if (chunk.tenant_id !== ctx.tenant_id) {
      return Response.json({ error: "tenant_id_mismatch_with_jwt" }, { status: 403 });
    }
  }

  // Re-run the zero-tolerance PII pre-filter on the new content. Skipping
  // this would let a reviewer launder PII into an approved chunk via the
  // replace path.
  const piiResult = detectZeroTolerancePII(body.content);
  if (piiResult.detected) {
    return Response.json(
      { error: "zero_tolerance_pii_in_replacement", categories: piiResult.categories },
      { status: 422 },
    );
  }

  let embedding: number[];
  try {
    embedding = await embed(body.content);
  } catch (err) {
    console.error("[replace-chunk] embedding failed: %s", err);
    return Response.json({ error: "embedding_failed" }, { status: 500 });
  }

  const update: Record<string, unknown> = {
    content: body.content,
    content_hash: Buffer.from(body.content).toString("base64").slice(0, 64),
    embedding: `[${embedding.join(",")}]`,
    updated_at: new Date().toISOString(),
  };
  if (body.source_url !== undefined) update.source_url = body.source_url;
  if (body.category) update.category = body.category;

  const { error: updErr } = await db
    .from("knowledge_chunks")
    .update(update)
    .eq("id", body.chunk_id);
  if (updErr) {
    console.error("[replace-chunk] update failed: %s", updErr.message);
    return Response.json({ error: updErr.message }, { status: 500 });
  }

  console.info("[replace-chunk] chunk=%s scope=%s replaced", body.chunk_id, chunk.scope);
  return Response.json({ ok: true, chunk_id: body.chunk_id, scope: chunk.scope });
});
