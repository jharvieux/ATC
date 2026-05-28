-- §15.12 sandbox mode wiring: conversations created while the tenant is in
-- sandbox mode are flagged is_test so analytics, supervisor sampling, and
-- audit surfaces can exclude them from real-traffic metrics.
--
-- The column is populated at conversation creation time based on the tenant's
-- current is_sandbox value. Toggling is_sandbox afterward does NOT retroactively
-- flip existing rows (a conversation that started in production stays
-- is_test=false even if the tenant later enters sandbox; the inverse for
-- sandbox→live).

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for the rare query "show me only real-traffic conversations" —
-- the vast majority of rows have is_test=false so a partial index keyed by
-- the rare TRUE rows is the right shape.
CREATE INDEX IF NOT EXISTS conversations_is_test_idx
  ON public.conversations(tenant_id, created_at DESC)
  WHERE is_test = TRUE;
