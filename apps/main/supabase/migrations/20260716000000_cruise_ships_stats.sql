-- Group-landing redesign — ship-stats display fields for cruise_ships.
--
-- All nullable: the invite-landing page and coordinator UI omit any stat
-- that's unset rather than showing a fake value. guest_capacity/decks/
-- built_year get a data-only backfill from RAG's knowledge_chunks
-- (ship_intel category) in a follow-up step, not this migration.
-- signature_feature has no ingestion path at all — manually curated only.
--
-- Existing cruise_ships_read policy + service_role grant already cover
-- these columns; no RLS/grant change needed.

ALTER TABLE public.cruise_ships
  ADD COLUMN guest_capacity    integer,
  ADD COLUMN decks             integer,
  ADD COLUMN built_year        integer,
  ADD COLUMN signature_feature text;
