-- #780 follow-up: cruise_ships.slug is always lower(cruisemapper_slug), so the
-- separate UNIQUE constraint is redundant — cruisemapper_slug UNIQUE already
-- enforces uniqueness at the source. The duplicate constraint caused safeAwait
-- to throw in upsertCruiseShipFromUrl when onConflict only targeted
-- cruisemapper_slug, poisoning ship discovery retries.
-- Replace with a plain index for lookup performance without the constraint risk.

ALTER TABLE public.cruise_ships DROP CONSTRAINT IF EXISTS cruise_ships_slug_key;
CREATE INDEX IF NOT EXISTS cruise_ships_slug_idx ON public.cruise_ships (slug);
