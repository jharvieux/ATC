-- §15.8 — Move the Stripe Price-ID mapping out of the STRIPE_PRICE_* env vars
-- and into the database so it becomes the in-app source of truth and Phase 3's
-- platform-admin pricing screen can write new Price IDs (after creating the
-- Stripe Prices) without a redeploy.
--
-- EPIC #1336, Phase 2 (#1338). Phase 1 (20260707000000) moved the *display +
-- abuse-revenue* tier prices to tier_definitions/pricing_seat_ladder; this PR
-- covers the *what-customers-are-actually-charged* Stripe Price IDs.
--
-- One row per (tenant_type, tier, billing_period, line_item) — the same 4-tuple
-- priceIdFor() keys on. `stripe_price_id` is the live Stripe Price ID;
-- `amount_cents` is the Stripe Price's unit_amount, kept alongside for display
-- and Phase 3 drift detection (nullable — the backfill fills it best-effort
-- from the Stripe API; Phase 3 sets it when it creates a Price).
--
-- NOT seeded in SQL: the Price IDs live in env secrets, which a migration can't
-- read (unlike Phase 1's code-constant prices). Seeding is a runtime step via
-- scripts/seed-stripe-price-map.ts. Until rows exist, priceIdFor() falls back
-- to the STRIPE_PRICE_* env vars, so this migration is a no-op for behavior.
--
-- No tenant_id column → not subject to the §5.1.2 four-policy RLS requirement
-- (mirrors tier_definitions / pricing_seat_ladder). RLS enabled with zero
-- policies = default-deny over the Data API; all reads/writes are service-role.

CREATE TABLE IF NOT EXISTS public.stripe_price_map (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_type     TEXT NOT NULL,
  tier            TEXT NOT NULL,
  billing_period  TEXT NOT NULL,
  line_item       TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  -- Live Stripe unit_amount in cents. Nullable: the price ID is what checkout
  -- needs; the amount is informational (display + drift detection) and may be
  -- unknown until the backfill reaches Stripe or Phase 3 writes it.
  amount_cents    INTEGER,
  currency        TEXT NOT NULL DEFAULT 'usd',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_price_map_key_unique UNIQUE (tenant_type, tier, billing_period, line_item),
  CONSTRAINT stripe_price_map_tenant_type_chk CHECK (tenant_type IN ('sub_host', 'byo_host')),
  CONSTRAINT stripe_price_map_tier_chk        CHECK (tier IN ('starter', 'pro', 'agency')),
  CONSTRAINT stripe_price_map_period_chk      CHECK (billing_period IN ('monthly', 'annual')),
  CONSTRAINT stripe_price_map_line_item_chk   CHECK (line_item IN ('base', 'additional_seats')),
  CONSTRAINT stripe_price_map_amount_nonneg   CHECK (amount_cents IS NULL OR amount_cents >= 0)
);

COMMENT ON TABLE public.stripe_price_map IS
  'Stripe Price-ID mapping (§15.8). One row per (tenant_type, tier, billing_period, line_item); read by priceIdFor() via loadPriceMap(). Global reference data, no tenant_id — service-role only (RLS-zero-policy). Seeded at runtime from STRIPE_PRICE_* env via scripts/seed-stripe-price-map.ts. EPIC #1336 Phase 2.';

ALTER TABLE public.stripe_price_map ENABLE ROW LEVEL SECURITY;
-- No policy by design: default-deny for anon/authenticated. service_role has
-- BYPASSRLS and is the only application read/write path (checkout + billing
-- routes use createServiceRoleClient; Phase 3's editor will too). A permissive
-- USING (true) policy is barred by the §5.1.2 migration lint gate.

GRANT SELECT ON public.stripe_price_map TO service_role;
-- INSERT/UPDATE/DELETE for the backfill script and the Phase 3 pricing editor
-- (both run as service_role); grant write now so Phase 3 needs no grant migration.
GRANT INSERT, UPDATE, DELETE ON public.stripe_price_map TO service_role;
