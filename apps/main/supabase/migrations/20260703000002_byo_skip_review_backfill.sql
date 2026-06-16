-- Data backfill: BYO hosts no longer require platform review (§15.10 change).
--
-- Self-service BYO tenants now go straight to active on completing onboarding.
-- Any byo_host tenant currently parked awaiting review predates that change and
-- would otherwise be stuck behind a review step that no longer exists. Move them
-- to the same terminal state the new branding-skip path produces:
--   onboarding_stage = 'complete', status = 'active'.
--
-- Scope is gated on tenant_type = 'byo_host' ONLY — sub-hosts keep the review
-- path. Pure data update (no column add/drop), so it ships in one migration.
--
-- "Parked" covers both observed/possible shapes:
--   • onboarding_stage = 'review_submitted' (the funnel's awaiting-review stage)
--   • status = 'pending_review' (the tenant-status review state, if ever set)
--
-- activated_at is only stamped when currently NULL, so a tenant activated by
-- some earlier path keeps its original activation timestamp.

UPDATE public.tenants
SET
  status = 'active',
  onboarding_stage = 'complete',
  activated_at = COALESCE(activated_at, now())
WHERE tenant_type = 'byo_host'
  AND (onboarding_stage = 'review_submitted' OR status = 'pending_review');
