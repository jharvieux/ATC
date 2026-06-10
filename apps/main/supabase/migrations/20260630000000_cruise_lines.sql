-- #780 Phase 1 — canonical cruise_lines table + alias table.
--
-- Expand step only (BP38). Does NOT touch free-text cruise_line columns on
-- quotes/bookings/etc. — that is Phase 2 (#781).
--
-- Uses per-entity alias tables rather than aliases text[] so that
-- alias_normalized UNIQUE is DB-enforced: an alias pointing at two lines
-- would silently corrupt every downstream join, and text[] columns can only
-- be enforced app-side (single-layer). See docs/design/cruise-canonical-normalization.md.

-- ── cruise_lines ──────────────────────────────────────────────────────────────

CREATE TABLE public.cruise_lines (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text        NOT NULL UNIQUE,          -- e.g. "royal-caribbean"
  canonical_name    text        NOT NULL,                 -- e.g. "Royal Caribbean International"
  display_name      text        NOT NULL,                 -- e.g. "Royal Caribbean"
  tier              text        NOT NULL CHECK (tier IN ('mainstream', 'premium', 'luxury')),
  is_active         boolean     NOT NULL DEFAULT true,
  cruisemapper_slug text        NOT NULL UNIQUE,          -- e.g. "Royal-Caribbean-1"
  website_url       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cruise_lines ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read (dropdowns, admin UI).
CREATE POLICY cruise_lines_read ON public.cruise_lines
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- All mutations go through service-role API routes gated by assertPermission.
GRANT SELECT ON public.cruise_lines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_lines TO service_role;

-- ── cruise_line_aliases ───────────────────────────────────────────────────────

CREATE TABLE public.cruise_line_aliases (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id   uuid        NOT NULL REFERENCES public.cruise_lines(id) ON DELETE CASCADE,
  alias            text        NOT NULL,
  alias_normalized text        NOT NULL UNIQUE, -- normalized lowercase/trimmed; UNIQUE enforces no alias points at two lines
  source           text        NOT NULL CHECK (source IN ('seed', 'admin', 'review_queue', 'import')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        REFERENCES public.users(id)  -- null for seed/system
);

CREATE INDEX cruise_line_aliases_line_id_idx ON public.cruise_line_aliases (cruise_line_id);

ALTER TABLE public.cruise_line_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY cruise_line_aliases_read ON public.cruise_line_aliases
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.cruise_line_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_line_aliases TO service_role;

-- ── Seed 17 lines ─────────────────────────────────────────────────────────────
-- Matches CRUISE_LINE_PAGES in discovery.ts (confirmed live 2026-06-05).
-- Viking: ocean-only (river lines excluded). Costa excluded (minimal US presence).

INSERT INTO public.cruise_lines (slug, canonical_name, display_name, tier, cruisemapper_slug, website_url) VALUES
  ('carnival',        'Carnival Cruise Line',              'Carnival',        'mainstream', 'Carnival-Cruise-Line-9',         'https://www.carnival.com'),
  ('royal-caribbean', 'Royal Caribbean International',     'Royal Caribbean', 'mainstream', 'Royal-Caribbean-1',              'https://www.royalcaribbean.com'),
  ('norwegian',       'Norwegian Cruise Line',             'Norwegian',       'mainstream', 'Norwegian-Cruise-Line-10',       'https://www.ncl.com'),
  ('celebrity',       'Celebrity Cruises',                 'Celebrity',       'premium',    'Celebrity-Cruises-5',            'https://www.celebritycruises.com'),
  ('princess',        'Princess Cruises',                  'Princess',        'premium',    'Princess-Cruises-3',             'https://www.princess.com'),
  ('holland-america', 'Holland America Line',              'Holland America', 'premium',    'Holland-America-11',             'https://www.hollandamerica.com'),
  ('msc',             'MSC Cruises',                       'MSC',             'mainstream', 'MSC-Cruises-13',                 'https://www.msccruisesusa.com'),
  ('disney',          'Disney Cruise Line',                'Disney',          'premium',    'Disney-Cruise-Line-12',          'https://disneycruise.disney.go.com'),
  ('virgin-voyages',  'Virgin Voyages',                    'Virgin Voyages',  'premium',    'Virgin-Voyages-109',             'https://www.virginvoyages.com'),
  ('viking',          'Viking Ocean Cruises',              'Viking',          'luxury',     'Viking-Cruises-78',              'https://www.vikingcruises.com'),
  ('oceania',         'Oceania Cruises',                   'Oceania',         'luxury',     'Oceania-Cruises-29',             'https://www.oceaniacruises.com'),
  ('cunard',          'Cunard Line',                       'Cunard',          'luxury',     'Cunard-31',                      'https://www.cunard.com'),
  ('azamara',         'Azamara',                           'Azamara',         'luxury',     'Azamara-Cruises-7',              'https://www.azamara.com'),
  ('regent',          'Regent Seven Seas Cruises',         'Regent',          'luxury',     'Regent-Seven-Seas-Cruises-28',   'https://www.rssc.com'),
  ('seabourn',        'Seabourn Cruise Line',              'Seabourn',        'luxury',     'Seabourn-Cruises-2',             'https://www.seabourn.com'),
  ('silversea',       'Silversea Cruises',                 'Silversea',       'luxury',     'Silversea-Cruises-19',           'https://www.silversea.com'),
  ('windstar',        'Windstar Cruises',                  'Windstar',        'luxury',     'Windstar-Cruises-30',            'https://www.windstarcruises.com');

-- Seed common aliases for the 17 lines. alias_normalized = lower(trim(alias)).
INSERT INTO public.cruise_line_aliases (cruise_line_id, alias, alias_normalized, source)
SELECT cl.id, a.alias, lower(trim(a.alias)), 'seed'
FROM public.cruise_lines cl
JOIN (VALUES
  ('carnival',        'Carnival Cruise Line'),
  ('carnival',        'CCL'),
  ('royal-caribbean', 'Royal Caribbean International'),
  ('royal-caribbean', 'Royal Caribbean Cruises'),
  ('royal-caribbean', 'RCI'),
  ('royal-caribbean', 'RCCL'),
  ('norwegian',       'Norwegian Cruise Line'),
  ('norwegian',       'NCL'),
  ('celebrity',       'Celebrity Cruises'),
  ('princess',        'Princess Cruises'),
  ('princess',        'Princess'),
  ('holland-america', 'Holland America Line'),
  ('holland-america', 'Holland America'),
  ('holland-america', 'HAL'),
  ('msc',             'MSC Cruises'),
  ('disney',          'Disney Cruise Line'),
  ('disney',          'DCL'),
  ('virgin-voyages',  'Virgin Voyages'),
  ('viking',          'Viking Ocean Cruises'),
  ('viking',          'Viking Cruises'),
  ('oceania',         'Oceania Cruises'),
  ('cunard',          'Cunard Line'),
  ('cunard',          'Cunard'),
  ('azamara',         'Azamara Cruises'),
  ('azamara',         'Azamara Club Cruises'),
  ('regent',          'Regent Seven Seas Cruises'),
  ('regent',          'RSSC'),
  ('seabourn',        'Seabourn Cruise Line'),
  ('seabourn',        'Seabourn'),
  ('silversea',       'Silversea Cruises'),
  ('silversea',       'Silversea'),
  ('windstar',        'Windstar Cruises'),
  ('windstar',        'Windstar')
) AS a(slug, alias) ON cl.slug = a.slug;
