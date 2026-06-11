-- §953 Phase A + fix #819 — expand cruisemapper_url_inventory constraints.
--
-- 1. kind: add 'cabin' for cabin-intel URLs (§953 Phase A).
-- 2. last_ingest_status: add 'not_cruise_ship' for ferry ships stamped by
--    stampFerrySkips() (fix #819; the function was shipped without this
--    constraint update, which would cause CHECK violations at runtime).
--
-- Both changes drop-and-recreate the inline (unnamed) CHECK constraints that
-- PostgreSQL auto-named with the standard <table>_<column>_check pattern.

ALTER TABLE public.cruisemapper_url_inventory
  DROP CONSTRAINT cruisemapper_url_inventory_kind_check,
  ADD CONSTRAINT cruisemapper_url_inventory_kind_check
    CHECK (kind IN ('ship', 'port', 'deck_plan', 'cabin'));

ALTER TABLE public.cruisemapper_url_inventory
  DROP CONSTRAINT cruisemapper_url_inventory_last_ingest_status_check,
  ADD CONSTRAINT cruisemapper_url_inventory_last_ingest_status_check
    CHECK (
      last_ingest_status IS NULL OR last_ingest_status IN (
        'ingested', 'updated', 'unchanged', 'robots_disallowed',
        'client_error', 'server_error', 'parse_failed', 'quarantined',
        'not_cruise_ship'
      )
    );
