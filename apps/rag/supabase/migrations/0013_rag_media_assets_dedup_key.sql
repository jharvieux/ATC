-- BP37 §33.6.3 — UNIQUE (entity_id, image_url) on rag_media_assets.
--
-- The BP37 image-asset recorder upserts by (entity_id, image_url) for
-- idempotency — re-running the quarterly scraper after CruiseMapper
-- republishes the same image must not produce a duplicate asset row.
--
-- (asset_id is the PK; this is an additional UNIQUE the upsert uses as
-- ON CONFLICT target.)

ALTER TABLE public.rag_media_assets
  ADD CONSTRAINT rag_media_assets_entity_image_url_key
  UNIQUE (entity_id, image_url);
