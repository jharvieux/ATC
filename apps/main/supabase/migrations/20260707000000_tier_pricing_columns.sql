-- §3.3 / §14 — Move subscription tier pricing from the hardcoded TypeScript
-- maps (TIER_BASE_PRICE_CENTS + SEAT_LADDER in lib/abuse/revenue.ts) into the
-- database so it becomes the single in-app source of truth and an operator can
-- change prices without a deploy. Mirrors the §27.4 abuse-base move
-- (20260625000004) and the resolveThresholds + TIER_BASE_FALLBACK pattern.
--
-- EPIC #1336, Phase 1 (#1337). The Stripe Price-ID mapping (what customers are
-- actually charged) moves to the DB in Phase 2; this PR covers the display +
-- abuse-revenue numbers only and keeps the code constant as a seeded fallback.
--
-- Money values are integer cents. Annual is the full annual price (not /12).
-- Fully idempotent (re-runnable) per the ledger-free psql-loop model (D-229):
-- column adds use IF NOT EXISTS, the seed UPDATEs only touch still-default rows
-- (so a re-apply never clobbers operator-edited prices), CREATE TABLE uses
-- IF NOT EXISTS, and the ladder seed is ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- 1. Per-tier base prices on tier_definitions (already RLS-enabled-zero-policy,
--    PLATFORM_READABLE, service-role-read). Adding columns changes neither the
--    RLS nor the grants snapshot.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tier_definitions
  ADD COLUMN IF NOT EXISTS base_price_monthly_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_price_annual_cents  INTEGER NOT NULL DEFAULT 0;

-- Seed from §3.3 (matches TIER_BASE_PRICE_CENTS as of 2026-06-22). The
-- `= 0` guard makes this re-runnable: once seeded (or operator-edited to a
-- non-zero value) a re-apply is a no-op and never resets a changed price.
UPDATE public.tier_definitions SET base_price_monthly_cents =  1900, base_price_annual_cents =  19000 WHERE code = 'byo_research'     AND base_price_monthly_cents = 0;
UPDATE public.tier_definitions SET base_price_monthly_cents =  5900, base_price_annual_cents =  59000 WHERE code = 'byo_professional' AND base_price_monthly_cents = 0;
UPDATE public.tier_definitions SET base_price_monthly_cents =  9900, base_price_annual_cents =  99000 WHERE code = 'byo_agency'       AND base_price_monthly_cents = 0;
UPDATE public.tier_definitions SET base_price_monthly_cents =  4900, base_price_annual_cents =  49000 WHERE code = 'sub_starter'      AND base_price_monthly_cents = 0;
UPDATE public.tier_definitions SET base_price_monthly_cents = 14900, base_price_annual_cents = 149000 WHERE code = 'sub_pro'          AND base_price_monthly_cents = 0;
UPDATE public.tier_definitions SET base_price_monthly_cents = 24900, base_price_annual_cents = 249000 WHERE code = 'sub_agency'       AND base_price_monthly_cents = 0;

-- ---------------------------------------------------------------------------
-- 2. Global agency seat ladder (was SEAT_LADDER). Applies to agency tiers and
--    prices seats 2+ (seat 1 is covered by the base price). Global reference
--    data (no tenant_id), so it follows the tier_definitions security model:
--    RLS enabled with NO policy (default-deny for anon/authenticated), all
--    reads via the service-role client, added to PLATFORM_READABLE_TABLES.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pricing_seat_ladder (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Inclusive upper seat number for this band. The final (open-ended) band
  -- uses the INT4 max sentinel 2147483647 = "and up".
  up_to_seat    INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL,
  annual_cents  INTEGER NOT NULL,
  -- Bands are walked in ascending sort_order; must be contiguous + unique.
  sort_order    INTEGER NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pricing_seat_ladder_up_to_positive CHECK (up_to_seat > 1),
  CONSTRAINT pricing_seat_ladder_nonneg CHECK (monthly_cents >= 0 AND annual_cents >= 0)
);

COMMENT ON TABLE public.pricing_seat_ladder IS
  'Global agency seat ladder (§3.3). Prices seats 2+ for agency tiers. Bands walked by sort_order ascending; final band uses up_to_seat = 2147483647 (and up). Global reference data, no tenant_id — service-role read only (see PLATFORM_READABLE_TABLES).';

-- Seed from SEAT_LADDER (lib/abuse/revenue.ts as of 2026-06-22):
--   seats 2-4 → $59/mo, seats 5-10 → $49/mo, seats 11+ → $39/mo.
-- ON CONFLICT (sort_order) keeps the re-apply a no-op without clobbering edits.
INSERT INTO public.pricing_seat_ladder (up_to_seat, monthly_cents, annual_cents, sort_order) VALUES
  (4,          5900, 59000, 1),
  (10,         4900, 49000, 2),
  (2147483647, 3900, 39000, 3)
ON CONFLICT (sort_order) DO NOTHING;

ALTER TABLE public.pricing_seat_ladder ENABLE ROW LEVEL SECURITY;
-- No policy by design: default-deny for anon/authenticated. service_role has
-- BYPASSRLS and is the only application read/write path. A permissive
-- USING (true) policy is barred by the §5.1.2 migration lint gate. If a direct
-- authenticated read path is ever added, pair it with a real row predicate.

GRANT SELECT ON public.pricing_seat_ladder TO service_role;
GRANT SELECT ON public.pricing_seat_ladder TO authenticated;
GRANT SELECT ON public.pricing_seat_ladder TO anon;
-- INSERT/UPDATE/DELETE for the platform-admin pricing editor (Phase 3) runs as
-- service_role; grant write now so the Phase 3 route needs no grant migration.
GRANT INSERT, UPDATE, DELETE ON public.pricing_seat_ladder TO service_role;
