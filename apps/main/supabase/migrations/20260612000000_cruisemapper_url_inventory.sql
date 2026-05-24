-- BP36 §33.5 — cruisemapper_url_inventory.
--
-- Tracks every URL the DIY scraper has discovered and (optionally) the
-- content hash from its last successful fetch. Subsequent fetches use
-- the stored hash to short-circuit unchanged pages — saving fetch work,
-- RAG re-ingest, and OpenAI re-embedding spend.
--
-- Platform-scoped (no tenant_id) — reference data shared across tenants.
-- RLS deliberately disabled (service-role write surface, no per-tenant
-- read path). Listed in db/rls-exceptions.txt.

CREATE TABLE public.cruisemapper_url_inventory (
  url             TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('ship', 'port', 'deck_plan')),
  content_hash    TEXT NULL,           -- last-known hash; null until first successful parse
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ingest_status TEXT NULL CHECK (
    last_ingest_status IS NULL OR last_ingest_status IN (
      'ingested', 'updated', 'unchanged', 'robots_disallowed',
      'client_error', 'server_error', 'parse_failed', 'quarantined'
    )
  ),
  last_error      TEXT NULL,
  related_chunk_id UUID NULL           -- knowledge_chunks id in the RAG service (no FK — cross-DB)
);

CREATE INDEX idx_cruisemapper_url_inventory_kind
  ON public.cruisemapper_url_inventory (kind, last_seen_at DESC);
CREATE INDEX idx_cruisemapper_url_inventory_status
  ON public.cruisemapper_url_inventory (last_ingest_status)
  WHERE last_ingest_status IS NOT NULL;
