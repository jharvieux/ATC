-- BP22 §6 — Replace the equal-weight TODO in match_knowledge_chunks with
-- platform-admin-configurable weights. The four weights become exponents on
-- the multiplicative factors (match/authority/recency) and a coefficient on
-- the additive feedback term. Default 1.0 across the board preserves current
-- behaviour exactly; the admin console exposes these knobs in the platform-
-- admin "Retrieval Weights" page.
--
-- Defaults rationale:
--   1.0 / 1.0 / 1.0 / 1.0 → composite = (match × authority × recency) + feedback
--   (identical to the pre-BP22 placeholder formula).
--
-- Tenants cannot override — these live in public.platform_settings, which has
-- no tenant_id column by design and is mutated only via withPlatformAdminAudit.
INSERT INTO public.platform_settings (key, value, description) VALUES
  ('retrieval_weight_match',     '1.0'::JSONB, 'Exponent on match_score in composite_confidence (POWER(match, w)). >1 boosts vector similarity; <1 dampens it. Default 1.0 = identity.'),
  ('retrieval_weight_authority', '1.0'::JSONB, 'Exponent on authority_score in composite_confidence. >1 boosts trusted-source bias; 0 makes authority irrelevant. Default 1.0 = identity.'),
  ('retrieval_weight_recency',   '1.0'::JSONB, 'Exponent on recency_score in composite_confidence. >1 strongly prefers fresh chunks; 0 makes recency irrelevant. Default 1.0 = identity.'),
  ('retrieval_weight_feedback',  '1.0'::JSONB, 'Multiplicative coefficient on the additive feedback_factor term (w * feedback). 0 disables feedback influence. Default 1.0 = identity.')
ON CONFLICT (key) DO NOTHING;
