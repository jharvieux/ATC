-- §6.10 (platform_settings cross-project resolution — option C, see MEMORY.md D-041)
--
-- platform_settings lives canonically in the main app's Supabase project (§6.10).
-- The spec says compute_feedback_factor reads it "via internal API", but that
-- would mean a plpgsql function performing an HTTP call — not possible in Postgres.
--
-- Resolution (option C chosen in D-041): replicate platform_settings structure
-- into this RAG project. The canonical values live in the main app; this table
-- is a cache kept current by a nightly sync job + on-change webhook (the sync
-- mechanism is deferred — see D-041). For now the four feedback knobs are seeded
-- with the same defaults as the main app so compute_feedback_factor returns
-- sensible values from day 1.
--
-- Schema deliberately omits updated_by_user_id FK because public.users lives
-- in the main app project, not here.

CREATE TABLE public.platform_settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: four feedback knobs from §6.10 (matches main app migration 20260521180000)
INSERT INTO public.platform_settings (key, value, description)
VALUES
  ('feedback_adjustment_limit',    '0.05'::JSONB, 'Max signed adjustment to retrieval score from feedback (per §6.10)'),
  ('feedback_min_signal_count',    '2'::JSONB,    'Minimum signal count to trigger any feedback adjustment (per §6.10)'),
  ('feedback_period_days',         '30'::JSONB,   'Lookback window for minimum signal count check (per §6.10)'),
  ('feedback_decay_halflife_days', '90'::JSONB,   'Halflife for exponential decay of older feedback signals (per §6.10)');
