-- §23.4 follow-up — seed the 8 remaining destination hero images.
--
-- Migration 0019 seeded 4 regions (caribbean, mediterranean, northern_europe,
-- alaska). The remaining 8 are added here after sourcing confirmed
-- hot-linkable images with appropriate licensing (Unsplash or Wikimedia Commons).
-- ON CONFLICT DO NOTHING against the partial unique index defined in 0019
-- keeps this migration idempotent.

INSERT INTO public.rag_media_assets
  (kind, entity_type, entity_id, scope, image_url, source_page_url, attribution, caption, content_type, width_px, height_px, source)
VALUES
  (
    'destination_hero', 'region', 'mexican_riviera', 'global',
    'https://images.unsplash.com/photo-1527734055665-8def83921139?w=1200&q=80&auto=format&fit=crop',
    'https://unsplash.com/photos/QsP5UmrFPlw',
    'Photo by Victor Hughes on Unsplash',
    'Aerial view of Cabo San Lucas, Mexico with the rocky arch and harbor',
    'image/jpeg', 1200, 800, 'unsplash'
  ),
  (
    'destination_hero', 'region', 'hawaii', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/NaPali_Coast_from_Pride_of_America.JPG/1200px-NaPali_Coast_from_Pride_of_America.JPG',
    'https://commons.wikimedia.org/wiki/File:NaPali_Coast_from_Pride_of_America.JPG',
    'Photo by Rwminix / Wikimedia Commons (CC BY-SA 3.0)',
    'Na Pali Coast, Kauai, Hawaii — rugged green sea cliffs viewed from the ocean',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'bermuda', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Horseshoebay.Bermuda.JPG/1200px-Horseshoebay.Bermuda.JPG',
    'https://commons.wikimedia.org/wiki/File:Horseshoebay.Bermuda.JPG',
    'Photo by Ekem / Wikimedia Commons (CC BY-SA 3.0)',
    'Horseshoe Bay beach in Bermuda with pink sand and turquoise water',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'bahamas', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Goat_Cay%2C_Exuma%2C_The_Bahamas.jpg/1200px-Goat_Cay%2C_Exuma%2C_The_Bahamas.jpg',
    'https://commons.wikimedia.org/wiki/File:Goat_Cay,_Exuma,_The_Bahamas.jpg',
    'Photo by DrGvago / Wikimedia Commons (CC BY-SA 4.0)',
    'Turquoise waters of Goat Cay, Exuma, The Bahamas',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'asia', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/Merlion_and_the_Singapore_Skyline_at_Night.JPG/1200px-Merlion_and_the_Singapore_Skyline_at_Night.JPG',
    'https://commons.wikimedia.org/wiki/File:Merlion_and_the_Singapore_Skyline_at_Night.JPG',
    'Photo by Merlion444 / Wikimedia Commons (CC0)',
    'Singapore skyline at night with the iconic Merlion fountain',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'south_pacific', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Bora_Bora_%2816542797633%29.jpg/1200px-Bora_Bora_%2816542797633%29.jpg',
    'https://commons.wikimedia.org/wiki/File:Bora_Bora_(16542797633).jpg',
    'Photo by The TerraMar Project / Wikimedia Commons (CC BY 2.0)',
    'Bora Bora''s turquoise lagoon and volcanic peak, French Polynesia',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'transatlantic', 'global',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/P%26O_Cruises_Oceana_01.JPG/1200px-P%26O_Cruises_Oceana_01.JPG',
    'https://commons.wikimedia.org/wiki/File:P%26O_Cruises_Oceana_01.JPG',
    'Photo by Piergiuliano Chesi / Wikimedia Commons (CC BY 3.0)',
    'P&O Cruises ocean liner underway at sea',
    'image/jpeg', 1200, 800, 'wikimedia'
  ),
  (
    'destination_hero', 'region', 'other', 'global',
    'https://images.unsplash.com/photo-1691315755851-7307bcb5e892?w=1200&q=80&auto=format&fit=crop',
    'https://unsplash.com/photos/a-view-of-a-harbor-with-boats-in-the-water-948iKHyc3UI',
    'Photo by Philip Myrtorp on Unsplash',
    'Scenic harbor view with boats in Monaco',
    'image/jpeg', 1200, 800, 'unsplash'
  )
ON CONFLICT (entity_id) WHERE entity_type = 'region' AND kind = 'destination_hero' AND scope = 'global'
DO NOTHING;
