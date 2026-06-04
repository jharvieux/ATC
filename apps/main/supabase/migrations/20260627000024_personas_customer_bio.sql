-- #652 — Add customer-facing bio column to personas.
--
-- The existing `background` column stores AI-prompt text ("You are X, you
-- grew up in Y...") which would surface internal prompt content if rendered
-- to customers on /agents/[slug]. The catalog at
-- apps/main/src/lib/agents/catalog.ts has been the de-facto source of
-- third-person marketing bios; moving that into the DB so platform admins
-- can edit it without a code deploy.
--
-- This is the expand step. The catalog's `bio` field stays for now as a
-- fallback (read code prefers DB → falls through to catalog). A follow-up
-- removes the catalog field once the DB-backed path has bedded in.

ALTER TABLE public.personas
  ADD COLUMN IF NOT EXISTS customer_bio TEXT;

-- Backfill the 6 known travel-concierge personas with the marketing copy
-- previously held in catalog.ts. Idempotent: only writes when customer_bio
-- is still null (re-applying the migration won't overwrite admin edits).

UPDATE public.personas SET customer_bio =
  E'Marcus has spent fifteen years walking the docks of San Juan, Aruba, and Cozumel — every Caribbean port has a different rhythm, and he knows which ones reward divers, which ones reward foodies, and which ones reward people who just want to read on a beach.\n\nHis specialty is matching the right island chain to your travel style. Eastern, Western, Southern, the ABC islands, the Bahamas — they sound interchangeable in a brochure and aren''t.'
WHERE slug = 'marcus-cole' AND customer_bio IS NULL;

UPDATE public.personas SET customer_bio =
  E'Marco grew up between Venice and Bari, so the Mediterranean isn''t a destination to him — it''s the place he keeps coming back to. He covers the Western Med (Barcelona, Marseille, Cinque Terre), the Adriatic (Croatia, Montenegro, the Greek isles), and the European river circuits — the Rhine, the Danube, the Douro.\n\nIf you care about food, ports of call, shore excursions that aren''t tourist traps, and not paying twice for the same museum — he''s your agent.'
WHERE slug = 'marco-bellini' AND customer_bio IS NULL;

UPDATE public.personas SET customer_bio =
  E'Priya started in concierge at the Taj Mahal Palace and moved through every luxury line — Regent, Silversea, Seabourn, Explora — before specializing in advising travelers on which ultra-premium product actually fits their definition of luxury.\n\nSpoiler: it varies wildly. A 14-night world cruise on a 600-passenger ship is a completely different product than a 7-night yacht-style sailing in Asia.'
WHERE slug = 'priya-sharma' AND customer_bio IS NULL;

UPDATE public.personas SET customer_bio =
  E'Captain Dave ran small expedition ships in southeast Alaska for twelve years. Glacier Bay, Tracy Arm, Endicott — he knows when to be there, which line gets you closest, and which lodge to add on for an inside passage finish.\n\nHe''s also the agent to ask about Antarctica, Iceland, and the Norwegian fjords. Cold-water cruising has its own rhythm and the wrong line in the wrong season ruins it.'
WHERE slug = 'captain-dave' AND customer_bio IS NULL;

UPDATE public.personas SET customer_bio =
  E'Maya specializes in cruises for travelers with mobility, sensory, dietary, or medical considerations — and for the families and companions who travel with them.\n\nShe knows which ships have which accessible cabin categories, which lines are realistic about ADA-style accommodations vs. which oversell, and which excursions actually work for travelers with limited mobility.'
WHERE slug = 'maya-patel' AND customer_bio IS NULL;

UPDATE public.personas SET customer_bio =
  E'Jenny has cruised every major family-friendly line with kids of her own — Disney, Royal Caribbean, Norwegian, Carnival, MSC. She knows which ships are realistic for a 4-year-old, which work for tweens, and which lines have kids'' clubs the kids actually want to go to.\n\nMultigenerational trips, kids-sail-free deals, picking the cabin so nobody has a meltdown — that''s her thing.'
WHERE slug = 'jenny-hartwell' AND customer_bio IS NULL;
