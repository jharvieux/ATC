-- §10.5a Configurable knobs for supervisor sampling and review
--
-- All four values per the spec's "Configurable knobs" table verbatim.
-- Tune downward once queue signal-to-noise is understood in production.

INSERT INTO public.platform_settings (key, value, description) VALUES
  (
    'supervisor_sample_rate_clean_pass',
    '0.01'::JSONB,
    '§10.5a: Fraction of clean-pass messages (allow + no findings) sampled for review. Default 1%.'
  ),
  (
    'supervisor_sample_rate_warning_pass',
    '0.10'::JSONB,
    '§10.5a: Fraction of warning-pass messages (allow + at least one warning finding) sampled. Default 10%.'
  ),
  (
    'supervisor_sample_rate_regen',
    '0.25'::JSONB,
    '§10.5a: Fraction of regen-attempted messages sampled (regardless of final outcome). Default 25%.'
  ),
  (
    'supervisor_review_retention_days',
    '90'::JSONB,
    '§10.5a: Days before a supervisor_review_queue row is eligible for purge. Default 90.'
  ),
  (
    'supervisor_slur_deny_list',
    '[]'::JSONB,
    '§10.2 / §24.5: Operator-managed list of slur/hate-speech strings for tone_drift lexical check. Seeded empty — operator must populate before opening to tenants.'
  )
ON CONFLICT (key) DO NOTHING;
