-- §26 — Constrain platform_admins.role to a known set.
--
-- The original migration (20260625000000) allowed any non-empty string.
-- The 2026-05-25 audit pass 2 (Finding A5) flagged this as a footgun:
-- once a call site starts branching on role (e.g.,
-- `if (admin.role === 'superadmin') doDestructiveThing()`), a typo at
-- seed time silently bypasses or over-grants. The roster is small enough
-- to enumerate.
--
-- INITIAL ROSTER:
--   superadmin — full platform admin, can manage other admins (future).
--   reviewer   — content moderation, RAG demotion, abuse review.
--   finance    — reconciliation, payouts, commission overrides.
--   support    — read-only access for customer-support tasks.
--
-- Adding a new role: change this constraint AND update the runbook at
-- docs/runbooks/platform-admin-seeding.md.

-- platform_admins has zero rows at the time of this migration (the
-- runbook tells the operator to seed manually after deploy), so the
-- ALTER below succeeds without any data conversion. Confirm before
-- running in production by selecting count(*).

ALTER TABLE public.platform_admins
  DROP CONSTRAINT IF EXISTS platform_admins_role_check;

ALTER TABLE public.platform_admins
  ADD CONSTRAINT platform_admins_role_check
    CHECK (role IN ('superadmin', 'reviewer', 'finance', 'support'));
