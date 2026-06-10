-- #780 Phase 1 — canonical ports table + alias table + review queue.
--
-- Expand step only (BP38). Does NOT touch free-text port columns.
--
-- port_info_chunks is linked via a nullable port_id FK (added in the next
-- migration). The ports table is the lean join target for dropdowns and
-- itinerary port-calls; port_info_chunks remains the content/terminal store.
--
-- Ports are seeded from cruisemapper_url_inventory (kind='port') for the
-- canonical_name / cruisemapper_slug, and from port_info_chunks for any rows
-- that already have parsed content (port_name used as canonical_name where
-- a matching port URL exists). country/region start NULL; populated by the
-- port ingest scraper via port-parser.ts as it processes URLs.
--
-- canonical_match_reviews is the review queue for Phase 2 (#781) backfill:
-- any free-text line/ship/port that can't be matched deterministically lands
-- here for a human to resolve via the admin UI.

-- ── ports ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.ports (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text        NOT NULL UNIQUE,     -- e.g. "nassau-bahamas"
  canonical_name    text        NOT NULL,            -- e.g. "Nassau, Bahamas"
  country           text,
  region            text,
  is_active         boolean     NOT NULL DEFAULT true,
  cruisemapper_slug text        UNIQUE,              -- last path segment of /ports/ URL; nullable for manually-added ports
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ports ENABLE ROW LEVEL SECURITY;

CREATE POLICY ports_read ON public.ports
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.ports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ports TO service_role;

-- ── port_aliases ──────────────────────────────────────────────────────────────

CREATE TABLE public.port_aliases (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  port_id          uuid        NOT NULL REFERENCES public.ports(id) ON DELETE CASCADE,
  alias            text        NOT NULL,
  alias_normalized text        NOT NULL UNIQUE,
  source           text        NOT NULL CHECK (source IN ('seed', 'admin', 'review_queue', 'import')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        REFERENCES public.users(id)
);

CREATE INDEX port_aliases_port_id_idx ON public.port_aliases (port_id);

ALTER TABLE public.port_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY port_aliases_read ON public.port_aliases
  FOR SELECT USING (auth.uid() IS NOT NULL);

GRANT SELECT ON public.port_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.port_aliases TO service_role;

-- ── canonical_match_reviews ───────────────────────────────────────────────────
-- Phase 2 (#781) review queue. Free-text values that don't match any canonical
-- entity land here for a human to resolve; resolution inserts an alias row.

CREATE TABLE public.canonical_match_reviews (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text        NOT NULL CHECK (entity_type IN ('line', 'ship', 'port')),
  value_normalized text        NOT NULL,
  value_raw        text        NOT NULL,
  occurrence_count integer     NOT NULL DEFAULT 1,
  sources          jsonb       NOT NULL DEFAULT '[]',  -- [{table, column, count}]
  suggested_id     uuid,                               -- nullable; trigram/AI suggestion
  suggestion_note  text,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapped', 'ignored')),
  resolved_by      uuid        REFERENCES public.users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, value_normalized)
);

CREATE INDEX canonical_match_reviews_status_idx ON public.canonical_match_reviews (status, entity_type);

ALTER TABLE public.canonical_match_reviews ENABLE ROW LEVEL SECURITY;

-- Platform admins read/write via service-role API routes.
GRANT SELECT ON public.canonical_match_reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canonical_match_reviews TO service_role;

-- ── Seed ports from cruisemapper_url_inventory ────────────────────────────────
-- URL shape: https://www.cruisemapper.com/ports/<PortName-ID>
-- canonical_name: derived from slug by stripping trailing numeric ID and
-- replacing hyphens with spaces (title-cased).

INSERT INTO public.ports (slug, canonical_name, cruisemapper_slug)
SELECT DISTINCT
  -- slug: last path segment minus trailing numeric ID, lowercased with hyphens
  lower(regexp_replace(
    regexp_replace(substring(url FROM '[^/]+$'), '-\d+$', ''),
    '[^a-z0-9]+', '-', 'gi'
  )) AS slug,
  -- canonical_name: title-cased from the slug portion
  initcap(replace(
    regexp_replace(substring(url FROM '[^/]+$'), '-\d+$', ''),
    '-', ' '
  )) AS canonical_name,
  -- cruisemapper_slug: full last path segment (with numeric ID)
  substring(url FROM '[^/]+$') AS cruisemapper_slug
FROM public.cruisemapper_url_inventory
WHERE kind = 'port'
ON CONFLICT (slug) DO NOTHING;

-- ── Seed port_aliases from port_info_chunks.name_aliases ─────────────────────
-- Match port_info_chunks to ports via canonical_name similarity, then insert
-- name_aliases as port_aliases rows. Unmatched port_info_chunks rows are left
-- un-linked (port_info_chunks.port_id FK added in next migration, starts NULL).

INSERT INTO public.port_aliases (port_id, alias, alias_normalized, source)
SELECT DISTINCT
  p.id,
  unnest(pic.name_aliases) AS alias,
  lower(trim(unnest(pic.name_aliases))) AS alias_normalized,
  'seed'
FROM public.port_info_chunks pic
JOIN public.ports p
  ON lower(trim(p.canonical_name)) = lower(trim(pic.port_name))
  OR lower(trim(p.canonical_name)) = lower(trim(pic.port_code))
WHERE pic.name_aliases IS NOT NULL
  AND array_length(pic.name_aliases, 1) > 0
ON CONFLICT (alias_normalized) DO NOTHING;
