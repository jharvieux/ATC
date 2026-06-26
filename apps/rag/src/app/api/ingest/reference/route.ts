// BP36 §33.5 — POST /api/ingest/reference
//
// Trusted batch reference ingest for scraped CruiseMapper static content
// (ships, ports, future categories). Bypasses the human-review queue;
// idempotent on `source_identifier` (deterministic key set by the
// scraper, e.g. 'cruisemapper:ship:<slug>').
//
// Behaviour:
//   - PII screen (same zero-tolerance gate as /api/ingest); on hit, 422.
//   - Look up existing chunk by source_url. If existing.content_hash
//     equals incoming SHA-256(text), return {status:'unchanged'} (no
//     embedding cost, no DB write).
//   - Otherwise embed + upsert the chunk.
//
// Authority defaults to 0.88 ('official' tier per §6.3) — CruiseMapper
// static reference is authoritative factual specification data. Caller
// can override via `authority` in the request.

export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { safeAwait } from "@/lib/db/safe-mutation";
import { embedWithUsage } from "@/lib/embeddings/openai";
import { logEmbeddingCall } from "@/lib/embeddings/cost-log";
import { enqueueEmbedding } from "@/lib/embeddings/batch/enqueue";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";
import { detectZeroTolerancePII } from "@/lib/pii/regex-prefilter";
import { ReferenceIngestRequestSchema } from "@/lib/schemas/reference-ingest";

interface IngestOutcome {
  status: "ingested" | "updated" | "unchanged" | "quarantined";
  chunk_id?: string | null;
  reason?: string;
}

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json({ error: "reference_ingest_requires_platform_admin" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Content-size guard — check before schema parse so the error is structured
  // 422 with machine-readable metadata rather than a generic 400.
  const MAX_BYTES = 500_000;
  const rawText = typeof (raw as Record<string, unknown>)?.text === "string"
    ? (raw as Record<string, unknown>).text as string
    : "";
  const actualBytes = Buffer.byteLength(rawText, "utf8");
  if (actualBytes > MAX_BYTES) {
    return Response.json(
      { error: "content_too_large", max_bytes: MAX_BYTES, actual_bytes: actualBytes },
      { status: 422 },
    );
  }

  let body: ReturnType<typeof ReferenceIngestRequestSchema.parse>;
  try {
    body = ReferenceIngestRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const pii = detectZeroTolerancePII(body.text);
  if (pii.detected) {
    const out: IngestOutcome = { status: "quarantined", reason: `zero_tolerance_pii_detected: ${pii.categories.join(", ")}` };
    return Response.json(out, { status: 422 });
  }

  const contentHash = createHash("sha256").update(body.text).digest("hex");
  const db = getRagDb();

  // BP37 §33.6.2 — validate related_asset_ids: each must exist AND its
  // scope must match the chunk's scope (this endpoint creates `global`
  // chunks, so any tenant-scope asset reference is rejected).
  if (body.related_asset_ids.length > 0) {
    const { data: assets } = await db
      .from("rag_media_assets")
      .select("asset_id, scope")
      .in("asset_id", body.related_asset_ids);
    const assetRows = (assets ?? []) as Array<{ asset_id: string; scope: "global" | "tenant" }>;
    const found = new Set(assetRows.map((a) => a.asset_id));
    const missing = body.related_asset_ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return Response.json(
        { error: "related_asset_ids_not_found", missing },
        { status: 400 },
      );
    }
    const tenantScopeIds = assetRows.filter((a) => a.scope !== "global").map((a) => a.asset_id);
    if (tenantScopeIds.length > 0) {
      return Response.json(
        { error: "asset_scope_mismatch", detail: "global chunk cannot reference tenant-scope assets", tenant_scope_ids: tenantScopeIds },
        { status: 400 },
      );
    }
  }

  // Idempotency lookup by source_url (the scraper guarantees source_url
  // uniqueness per source_identifier).
  let existing: { id: string; content_hash: string } | null = null;
  if (body.source_url) {
    const { data } = await db
      .from("knowledge_chunks")
      .select("id, content_hash")
      .eq("source_url", body.source_url)
      .eq("scope", "global")
      .maybeSingle();
    existing = (data as { id: string; content_hash: string } | null) ?? null;
  }

  if (existing && existing.content_hash === contentHash) {
    const out: IngestOutcome = { status: "unchanged", chunk_id: existing.id };
    return Response.json(out);
  }

  // Embed. Batch-mode behavior matches /ingest/itinerary (issue #686):
  // updates keep prior embedding; inserts omit embedding (NULL); both enqueue.
  const batchEnabled = isEmbeddingBatchEnabled();
  let embedding: number[] | null = null;
  let syncEmbeddingUsage: { prompt_tokens: number; model: string; latency_ms: number } | null = null;
  if (!batchEnabled) {
    const t0 = Date.now();
    try {
      const r = await embedWithUsage(body.text);
      embedding = r.embedding;
      syncEmbeddingUsage = { prompt_tokens: r.prompt_tokens, model: r.model, latency_ms: Date.now() - t0 };
    } catch (err) {
      console.error("[ingest/reference] embedding failed:", err);
      return Response.json({ error: "embedding_failed" }, { status: 500 });
    }
  }

  const nowIso = new Date().toISOString();
  const authority = body.authority ?? 0.88;
  const sourceUrl = body.source_url ?? null;
  const sourceDomain = body.source_domain ?? null;

  let chunkId: string;
  let outcomeStatus: "updated" | "ingested";

  if (existing) {
    const updateFields: Record<string, unknown> = {
      content: body.text,
      content_hash: contentHash,
      category: body.category,
      cruise_line_or_supplier: body.cruise_line ?? null,
      ship_or_property: body.ship ?? null,
      destination: body.destination ?? null,
      ingested_at: nowIso,
      status: "approved",
      related_asset_ids: body.related_asset_ids,
    };
    if (!batchEnabled && embedding) {
      updateFields.embedding = `[${embedding.join(",")}]`;
    }
    const { data: updated, error: updErr } = await db
      .from("knowledge_chunks")
      .update(updateFields)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (updErr || !updated) {
      console.error("[ingest/reference] chunk update failed:", updErr);
      return Response.json({ error: "chunk_update_failed" }, { status: 500 });
    }
    chunkId = updated.id as string;
    outcomeStatus = "updated";
  } else {
    const insertFields: Record<string, unknown> = {
      content: body.text,
      content_hash: contentHash,
      scope: "global",
      tenant_id: null,
      category: body.category,
      cruise_line_or_supplier: body.cruise_line ?? null,
      ship_or_property: body.ship ?? null,
      destination: body.destination ?? null,
      source_type: "scraped_reference",
      source_url: sourceUrl,
      source_domain: sourceDomain,
      authority_auto: authority,
      contains_pricing: false,
      status: "approved",
      ingested_at: nowIso,
      approved_at: nowIso,
      related_asset_ids: body.related_asset_ids,
    };
    if (!batchEnabled && embedding) {
      insertFields.embedding = `[${embedding.join(",")}]`;
    }
    const { data: inserted, error: insErr } = await db
      .from("knowledge_chunks")
      .insert(insertFields)
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[ingest/reference] chunk insert failed:", insErr);
      return Response.json({ error: "chunk_insert_failed" }, { status: 500 });
    }
    chunkId = inserted.id as string;
    outcomeStatus = "ingested";
  }

  if (batchEnabled) {
    try {
      // Platform-admin ingest of a global chunk — no tenant to attribute cost to.
      await enqueueEmbedding({ chunk_id: chunkId, content: body.text, tenant_id: null, db });
    } catch (err) {
      console.error("[ingest/reference] enqueue embedding failed:", err);
      // INSERT path: orphan chunk would create a duplicate on retry. Roll
      // back. UPDATE path: chunk already existed before this request, leave
      // it alone.
      if (outcomeStatus === "ingested") {
        await safeAwait(
          db.from("knowledge_chunks").delete().eq("id", chunkId),
          "knowledge_chunks.delete.orphan_after_enqueue_failure",
        );
      }
      return Response.json({ error: "embedding_enqueue_failed" }, { status: 500 });
    }
  } else if (syncEmbeddingUsage) {
    try {
      await logEmbeddingCall({
        db,
        tenant_id: null,
        model: syncEmbeddingUsage.model,
        source: "sync",
        input_tokens: syncEmbeddingUsage.prompt_tokens,
        latency_ms: syncEmbeddingUsage.latency_ms,
      });
    } catch (err) {
      console.warn("[ingest/reference] cost log failed:", err);
    }
  }

  const out: IngestOutcome = { status: outcomeStatus, chunk_id: chunkId };
  return Response.json(out);
});
