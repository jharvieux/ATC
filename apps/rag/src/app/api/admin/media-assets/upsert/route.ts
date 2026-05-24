// BP37 §33.6 — POST /api/admin/media-assets/upsert
//
// Upserts a rag_media_assets row on (entity_id, image_url). Used by the
// CruiseMapper DIY deck plan ingest (BP37) and any future scraper that
// records hot-linked images. Caller must be platform-admin.

export const dynamic = "force-dynamic";

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { MediaAssetUpsertSchema } from "@/lib/schemas/media-asset-upsert";

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json({ error: "media_asset_upsert_requires_platform_admin" }, { status: 403 });
  }

  let body: ReturnType<typeof MediaAssetUpsertSchema.parse>;
  try {
    const raw = await req.json();
    body = MediaAssetUpsertSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Scope/tenant_id invariant — mirrors the CHECK constraint on the table.
  if (body.scope === "tenant" && !body.tenant_id) {
    return Response.json({ error: "tenant_id_required_for_tenant_scope" }, { status: 400 });
  }
  if (body.scope === "global" && body.tenant_id) {
    return Response.json({ error: "tenant_id_must_be_null_for_global_scope" }, { status: 400 });
  }

  const db = getRagDb();
  const { data, error } = await db
    .from("rag_media_assets")
    .upsert(
      {
        kind: body.kind,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        scope: body.scope,
        tenant_id: body.tenant_id ?? null,
        image_url: body.image_url,
        source_page_url: body.source_page_url,
        attribution: body.attribution,
        caption: body.caption ?? null,
        content_type: body.content_type ?? null,
        width_px: body.width_px ?? null,
        height_px: body.height_px ?? null,
        source: body.source,
      },
      { onConflict: "entity_id,image_url" },
    )
    .select("asset_id")
    .single();

  if (error || !data) {
    console.error("[media-assets/upsert] failed:", error);
    return Response.json({ error: "asset_upsert_failed" }, { status: 500 });
  }

  return Response.json({ asset_id: data.asset_id as string });
});
