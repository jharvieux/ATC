-- BP33 §33.6.1 — rag_media_assets table.
--
-- First-class asset surface in the RAG service. Hot-linked images
-- (CruiseMapper deck plans, ship photos, port maps) referenced by URL —
-- NOT re-hosted. Linked to knowledge_chunks via knowledge_chunks.related_asset_ids
-- (§33.6.2; added in 0011_knowledge_chunks_related_asset_ids.sql).
--
-- Schema convention: this service uses `public.` (not the spec's `rag.`)
-- to match every other RAG migration.
--
-- RLS: SELECT for global rows is open; tenant-scope rows readable only by
-- the owning tenant. Writes are service-role only (the ingest pipeline).
-- The RAG service's auth model is the inter-service JWT (§8.3); RLS here
-- enforces the global-vs-tenant scope boundary at the row level as
-- defense-in-depth alongside the JWT-claim filter the retrieval
-- function applies.

CREATE TABLE public.rag_media_assets (
  asset_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('deck_plan','ship_photo','port_map','other')),
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('ship','port','deck','cruise_line')),
  entity_id       TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','tenant')),
  tenant_id       UUID NULL,
  image_url       TEXT NOT NULL,
  source_page_url TEXT NOT NULL,
  attribution     TEXT NOT NULL,
  caption         TEXT NULL,
  content_type    TEXT NULL,
  width_px        INTEGER NULL,
  height_px       INTEGER NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL,
  CONSTRAINT tenant_id_when_tenant_scope
    CHECK ((scope = 'tenant' AND tenant_id IS NOT NULL)
        OR (scope = 'global' AND tenant_id IS NULL))
);

CREATE INDEX idx_assets_entity ON public.rag_media_assets (entity_type, entity_id);
CREATE INDEX idx_assets_kind   ON public.rag_media_assets (kind);
CREATE INDEX idx_assets_tenant ON public.rag_media_assets (tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE public.rag_media_assets ENABLE ROW LEVEL SECURITY;

-- Global scope is readable by any authenticated caller; tenant scope
-- only to the owning tenant. The §8.9 retrieval-scope pattern reads
-- the JWT 'tenant_id' claim via the `current_setting('request.jwt.claim.tenant_id')`
-- shape used elsewhere in this service. For the v1 ingest path this
-- restriction is moot — writes are service-role only — but the SELECT
-- policy belongs to the row.
CREATE POLICY rag_media_assets_select ON public.rag_media_assets
  FOR SELECT USING (
    scope = 'global'
    OR tenant_id::text = current_setting('request.jwt.claim.tenant_id', true)
  );

-- INSERT / UPDATE / DELETE: service-role only. The ingest pipeline runs
-- under the service key; no caller path constructs rows.
-- (No INSERT/UPDATE/DELETE policies — RLS denies by default when no
-- matching policy exists.)
