-- #827 — allow kind='sailing_detail' in cruisemapper_url_inventory.
--
-- The per-sailing detail enrichment (sailing-ingest.ts) records each sailing's
-- cruise.json URL with kind='sailing_detail' once its ports are fetched +
-- ingested, so later runs skip the fetch (ports are immutable once scheduled).
-- Additive + backward-compatible: old code never writes the new value, and the
-- write path is gated off (CRUISEMAPPER_DETAIL_FETCH_ENABLED) until enabled.

ALTER TABLE public.cruisemapper_url_inventory
  DROP CONSTRAINT IF EXISTS cruisemapper_url_inventory_kind_check;

ALTER TABLE public.cruisemapper_url_inventory
  ADD CONSTRAINT cruisemapper_url_inventory_kind_check
  CHECK (kind IN ('ship', 'port', 'deck_plan', 'sailing_detail'));
