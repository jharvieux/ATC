-- #780 Phase 1 — canonical cruise_ships table + alias table.
--
-- Expand step only (BP38). Does NOT touch free-text ship columns on
-- quotes/bookings/etc. — that is Phase 2 (#781).
--
-- Ships are NOT seeded here: CruiseMapper ship URLs do not embed the
-- cruise line ID, so line-ship attribution cannot be derived from
-- cruisemapper_url_inventory in a SQL migration. The updated discoverShipUrls
-- (part of this PR's scraper cutover) will upsert rows with correct
-- cruise_line_id during the first post-deploy discovery run.
--
-- ship_class is populated by the ingest scraper (parseShipPage().shipClass).
--
-- Per-entity alias table (not aliases text[]) for the same reason as
-- cruise_line_aliases: alias_normalized UNIQUE enforces cross-row integrity.

-- ── cruise_ships ──────────────────────────────────────────────────────────────

CREATE TABLE public.cruise_ships (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id    uuid        NOT NULL REFERENCES public.cruise_lines(id),
  slug              text        NOT NULL UNIQUE,     -- e.g. "symphony-of-the-seas"
  canonical_name    text        NOT NULL,            -- e.g. "Symphony of the Seas"
  ship_class        text,                            -- e.g. "Oasis Class" — from parseShipPage()
  is_active         boolean     NOT NULL DEFAULT true,
  cruisemapper_slug text        NOT NULL UNIQUE,     -- last path segment of /ships/ URL
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cruise_ships_line_id_idx ON public.cruise_ships (cruise_line_id);

ALTER TABLE public.cruise_ships ENABLE ROW LEVEL SECURITY;

CREATE POLICY cruise_ships_read ON public.cruise_ships
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.cruise_ships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_ships TO service_role;

-- ── cruise_ship_aliases ───────────────────────────────────────────────────────

CREATE TABLE public.cruise_ship_aliases (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_ship_id   uuid        NOT NULL REFERENCES public.cruise_ships(id) ON DELETE CASCADE,
  alias            text        NOT NULL,
  alias_normalized text        NOT NULL UNIQUE,
  source           text        NOT NULL CHECK (source IN ('seed', 'admin', 'review_queue', 'import')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        REFERENCES public.users(id)
);

CREATE INDEX cruise_ship_aliases_ship_id_idx ON public.cruise_ship_aliases (cruise_ship_id);

ALTER TABLE public.cruise_ship_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY cruise_ship_aliases_read ON public.cruise_ship_aliases
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.cruise_ship_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_ship_aliases TO service_role;
