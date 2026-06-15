-- #783 Phase 3 — structured sailing catalog.
--
-- cruise_sailings: one row per (ship, departure_date) sailing.
-- sailing_port_calls: ordered ports for each sailing.
--
-- Populated by the sailing ingest (refresh-cruisemapper-sailings /
-- refresh-cruisemapper-static Inngest functions) once port enrichment
-- has fetched the cruise.json detail for a sailing.
--
-- port_id is nullable: best-effort match against the ports catalog;
-- unrecognised port names land without a FK.

-- ── cruise_sailings ──────────────────────────────────────────────────────────
CREATE TABLE public.cruise_sailings (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_ship_id    uuid        NOT NULL REFERENCES public.cruise_ships(id) ON DELETE CASCADE,
  departure_date    date        NOT NULL,
  departure_port    text        NOT NULL,
  duration_nights   int         NOT NULL,
  region            text,
  starting_price    numeric(10, 2),
  source_url        text,
  content_hash      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cruise_ship_id, departure_date)
);

CREATE INDEX cruise_sailings_ship_date_idx
  ON public.cruise_sailings (cruise_ship_id, departure_date);

ALTER TABLE public.cruise_sailings ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read (cascading dropdowns in group-booking creation).
CREATE POLICY "cruise_sailings_read" ON public.cruise_sailings
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.cruise_sailings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_sailings TO service_role;

-- ── sailing_port_calls ───────────────────────────────────────────────────────
CREATE TABLE public.sailing_port_calls (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  sailing_id  uuid  NOT NULL REFERENCES public.cruise_sailings(id) ON DELETE CASCADE,
  port_id     uuid  REFERENCES public.ports(id) ON DELETE SET NULL,
  port_name   text  NOT NULL,
  day_index   int   NOT NULL,
  UNIQUE (sailing_id, day_index)
);

CREATE INDEX sailing_port_calls_sailing_idx
  ON public.sailing_port_calls (sailing_id, day_index);

ALTER TABLE public.sailing_port_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sailing_port_calls_read" ON public.sailing_port_calls
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.sailing_port_calls TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sailing_port_calls TO service_role;

-- ── groups.sailing_id (expand step) ─────────────────────────────────────────
-- Nullable FK from a group booking to its specific sailing. Populated when the
-- coordinator uses the catalog dropdowns (line → ship → sailing) on group
-- creation. Groups created via the legacy free-text form have NULL here.
ALTER TABLE public.groups
  ADD COLUMN sailing_id uuid REFERENCES public.cruise_sailings(id) ON DELETE SET NULL;

CREATE INDEX groups_sailing_id_idx ON public.groups (sailing_id)
  WHERE sailing_id IS NOT NULL;
