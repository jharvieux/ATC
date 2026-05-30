-- §23.4 / §33.6.1 — extend rag_media_assets so destination hero images
-- can be retrieved by broad cruise region (caribbean, alaska, etc.)
-- rather than tied to a specific ship/port/deck/cruise_line.
--
-- The original schema (migration 0010) restricted entity_type to
-- {'ship','port','deck','cruise_line'} which fits per-entity images
-- (CruiseMapper deck plans, ship photos, port maps) but not the
-- category-level imagery used by pre-cruise email templates ("a beach
-- scene for Caribbean", "glaciers for Alaska"). entity_id stays TEXT
-- so we just write 'caribbean', 'alaska', etc.
--
-- Also adds 'destination_hero' to the kind enum since none of the
-- existing values (deck_plan, ship_photo, port_map) describe a category
-- illustration used for marketing rather than navigation.
--
-- Seed: 4 regions sourced via web research, attribution included per
-- the Unsplash + Wikimedia Commons licenses. The remaining cruise
-- regions (mexican_riviera, hawaii, bermuda, bahamas, transatlantic,
-- south_pacific) can be added later by the operator via the admin UI
-- once it ships, or by appending INSERT rows in a follow-up migration.

ALTER TABLE public.rag_media_assets
  DROP CONSTRAINT IF EXISTS rag_media_assets_entity_type_check;

ALTER TABLE public.rag_media_assets
  ADD CONSTRAINT rag_media_assets_entity_type_check
  CHECK (entity_type IN ('ship','port','deck','cruise_line','region'));

ALTER TABLE public.rag_media_assets
  DROP CONSTRAINT IF EXISTS rag_media_assets_kind_check;

ALTER TABLE public.rag_media_assets
  ADD CONSTRAINT rag_media_assets_kind_check
  CHECK (kind IN ('deck_plan','ship_photo','port_map','destination_hero','other'));

-- Seed: 4 confirmed regions. ON CONFLICT DO NOTHING so re-applying the
-- migration against a DB that already has these rows succeeds cleanly.
-- (rag_media_assets has no natural unique constraint on (entity_type,
-- entity_id, kind); we use a partial unique index just for these
-- destination_hero rows so the seed is idempotent.)

CREATE UNIQUE INDEX IF NOT EXISTS rag_media_assets_destination_hero_one_per_region
  ON public.rag_media_assets (entity_id)
  WHERE entity_type = 'region' AND kind = 'destination_hero' AND scope = 'global';

INSERT INTO public.rag_media_assets
  (kind, entity_type, entity_id, scope, image_url, source_page_url, attribution, caption, content_type, width_px, height_px, source)
VALUES
  (
    'destination_hero', 'region', 'caribbean', 'global',
    'https://images.unsplash.com/photo-1655299417498-52f3a304c2a4?w=1200&q=80&auto=format&fit=crop',
    'https://unsplash.com/photos/a-beach-with-palm-trees-and-blue-water-P41tKN3uZhw',
    'Photo by Christian Lendl on Unsplash',
    'A Caribbean beach with palm trees and turquoise water',
    'image/jpeg', 1200, 800, 'unsplash'
  ),
  (
    'destination_hero', 'region', 'mediterranean', 'global',
    'https://images.unsplash.com/photo-1696519669474-3001c0e2b548?w=1200&q=80&auto=format&fit=crop',
    'https://unsplash.com/photos/an-aerial-view-of-a-village-on-a-cliff-overlooking-the-ocean-7RaonO0Jn9E',
    'Photo by Dawid Tkocz on Unsplash',
    'Aerial view of Santorini''s white village on the cliffs overlooking the Aegean',
    'image/jpeg', 1200, 800, 'unsplash'
  ),
  (
    'destination_hero', 'region', 'northern_europe', 'global',
    'https://images.unsplash.com/photo-1722446636397-e069a5849350?w=1200&q=80&auto=format&fit=crop',
    'https://unsplash.com/photos/a-cruise-ship-docked-in-a-bay-surrounded-by-mountains-47N8u-sYSBk',
    'Photo by Tom Donders on Unsplash',
    'A cruise ship at anchor in Geirangerfjord, Norway',
    'image/jpeg', 1200, 800, 'unsplash'
  ),
  (
    'destination_hero', 'region', 'alaska', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Hubbard_Glacier_calving_Alaska._%2812027161386%29.jpg/1200px-Hubbard_Glacier_calving_Alaska._%2812027161386%29.jpg',
    'https://commons.wikimedia.org/wiki/File:Hubbard_Glacier_calving_Alaska._(12027161386).jpg',
    'Photo by Doug Knuth / Wikimedia Commons (CC BY-SA 2.0)',
    'Hubbard Glacier calving in Disenchantment Bay, Alaska',
    'image/jpeg', 1200, 800, 'wikimedia'
  )
ON CONFLICT (entity_id) WHERE entity_type = 'region' AND kind = 'destination_hero' AND scope = 'global'
DO NOTHING;
