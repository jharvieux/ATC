-- #781 Phase 2 Step 1 (Expand) — add nullable cruise_line_id / cruise_ship_id
-- FK columns alongside existing free-text cruise_line / ship_name columns on
-- quote_options, groups, bookings, and price_watches.
--
-- BP38 EXPAND STEP ONLY. No free-text columns dropped, no readers repointed.
-- Step 2 (backfill + read-switchover) and Step 3 (contract) are separate PRs.
--
-- ON DELETE SET NULL: cruise_lines/cruise_ships are platform reference data that
-- should be deactivated (is_active=false) not deleted. SET NULL preserves
-- customer rows if a canonical row is ever removed rather than blocking the
-- delete or cascade-dropping booking/group records.

-- ── quote_options ─────────────────────────────────────────────────────────────

ALTER TABLE public.quote_options
  ADD COLUMN cruise_line_id uuid REFERENCES public.cruise_lines(id) ON DELETE SET NULL,
  ADD COLUMN cruise_ship_id uuid REFERENCES public.cruise_ships(id) ON DELETE SET NULL;

CREATE INDEX quote_options_cruise_line_id_idx ON public.quote_options (cruise_line_id)
  WHERE cruise_line_id IS NOT NULL;
CREATE INDEX quote_options_cruise_ship_id_idx ON public.quote_options (cruise_ship_id)
  WHERE cruise_ship_id IS NOT NULL;

-- ── groups ────────────────────────────────────────────────────────────────────

ALTER TABLE public.groups
  ADD COLUMN cruise_line_id uuid REFERENCES public.cruise_lines(id) ON DELETE SET NULL,
  ADD COLUMN cruise_ship_id uuid REFERENCES public.cruise_ships(id) ON DELETE SET NULL;

CREATE INDEX groups_cruise_line_id_idx ON public.groups (cruise_line_id)
  WHERE cruise_line_id IS NOT NULL;
CREATE INDEX groups_cruise_ship_id_idx ON public.groups (cruise_ship_id)
  WHERE cruise_ship_id IS NOT NULL;

-- ── bookings ──────────────────────────────────────────────────────────────────

ALTER TABLE public.bookings
  ADD COLUMN cruise_line_id uuid REFERENCES public.cruise_lines(id) ON DELETE SET NULL,
  ADD COLUMN cruise_ship_id uuid REFERENCES public.cruise_ships(id) ON DELETE SET NULL;

CREATE INDEX bookings_cruise_line_id_idx ON public.bookings (cruise_line_id)
  WHERE cruise_line_id IS NOT NULL;
CREATE INDEX bookings_cruise_ship_id_idx ON public.bookings (cruise_ship_id)
  WHERE cruise_ship_id IS NOT NULL;

-- ── price_watches ─────────────────────────────────────────────────────────────
-- price_watches uses "ship" (not "ship_name") for the free-text column; the FK
-- column follows the standard naming.

ALTER TABLE public.price_watches
  ADD COLUMN cruise_line_id uuid REFERENCES public.cruise_lines(id) ON DELETE SET NULL,
  ADD COLUMN cruise_ship_id uuid REFERENCES public.cruise_ships(id) ON DELETE SET NULL;

CREATE INDEX price_watches_cruise_line_id_idx ON public.price_watches (cruise_line_id)
  WHERE cruise_line_id IS NOT NULL;
CREATE INDEX price_watches_cruise_ship_id_idx ON public.price_watches (cruise_ship_id)
  WHERE cruise_ship_id IS NOT NULL;
