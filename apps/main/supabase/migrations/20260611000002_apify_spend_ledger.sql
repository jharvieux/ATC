-- BP34 §33.9.3 — apify_spend_ledger.
--
-- One row per Apify actor invocation. Sum the current calendar month to
-- enforce APIFY_MONTHLY_BUDGET_USD_CEILING. Platform-scoped (Apify spend
-- is platform-wide, not tenant-attributable) — no tenant_id; RLS disabled
-- per the same rationale as pricing_cache. Listed in db/rls-exceptions.txt.

CREATE TABLE public.apify_spend_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        TEXT NOT NULL,       -- e.g., 'sercul/royal-caribbean'
  actor_run_id    TEXT NULL,           -- Apify-side run id (null on pre-flight estimate failures)
  invoked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spend_usd       NUMERIC(8,4) NOT NULL CHECK (spend_usd >= 0),
  results_count   INTEGER NULL,
  context         JSONB NULL,          -- { estimated: true, ... } when spend is pre-flight estimate
  cruise_line     TEXT NULL,           -- denormalized for per-line reporting
  status          TEXT NOT NULL CHECK (status IN ('succeeded','failed','partial','estimated_skipped'))
);

-- Postgres rejects non-IMMUTABLE functions in index expressions (error
-- 42P17). date_trunc(text, timestamptz) is STABLE (depends on session
-- TimeZone), not IMMUTABLE — so an index on date_trunc('month', invoked_at)
-- can't be created on stock Postgres. Same root cause as the BP27 fix
-- in 9361e2b. The Apify spend code paths use
--   WHERE invoked_at >= date_trunc('month', NOW())
-- which Postgres serves from a plain B-tree on invoked_at via range scan.
CREATE INDEX idx_apify_spend_ledger_invoked_at
  ON public.apify_spend_ledger (invoked_at DESC);
CREATE INDEX idx_apify_spend_ledger_actor
  ON public.apify_spend_ledger (actor_id, invoked_at DESC);
