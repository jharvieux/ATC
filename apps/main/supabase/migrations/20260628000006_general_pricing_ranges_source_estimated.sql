-- #828b — allow source='estimated' in general_pricing_ranges.
--
-- CruiseMapper removed its per-cabin price widgets (#820), so the only free
-- price is the per-sailing interior "from $X" lead-in. We DERIVE ballpark
-- per-cabin ranges from those lead-ins (interior min/max × category
-- multipliers) and store them with source='estimated' so the provenance is
-- honest — these are not scraped per-cabin prices. Additive + backward-compatible.

ALTER TABLE public.general_pricing_ranges
  DROP CONSTRAINT IF EXISTS general_pricing_ranges_source_check;

ALTER TABLE public.general_pricing_ranges
  ADD CONSTRAINT general_pricing_ranges_source_check
  CHECK (source IN ('diy_cruisemapper', 'manual', 'estimated'));
