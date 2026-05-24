-- BP30 §30.4 fixture: legal_documents — current versions of all 7 types.
--
-- Includes a prior version of 'tou' (v0, superseded) so the §17.5 re-consent
-- flow has historical data to exercise.
--
-- Idempotent via ON CONFLICT on the (document_type, version) UNIQUE constraint.

INSERT INTO public.legal_documents (
  id, document_type, version, content_markdown, summary_of_changes,
  effective_at, superseded_at
) VALUES
  ('44444444-0000-0000-0000-000000000001', 'tou', 0,
   '# Terms of Use — v0 (superseded)\n\nPlaceholder content for testing the re-consent flow.',
   'Initial version', NOW() - INTERVAL '180 days', NOW() - INTERVAL '90 days'),
  ('44444444-0000-0000-0000-000000000002', 'tou', 1,
   '# Terms of Use — v1\n\nPlaceholder content for the current ToU.',
   'Updated dispute-resolution section', NOW() - INTERVAL '90 days', NULL),
  ('44444444-0000-0000-0000-000000000003', 'privacy_policy', 1,
   '# Privacy Policy — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL),
  ('44444444-0000-0000-0000-000000000004', 'ai_disclaimer', 1,
   '# AI Disclaimer — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL),
  ('44444444-0000-0000-0000-000000000005', 'cookie_policy', 1,
   '# Cookie Policy — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL),
  ('44444444-0000-0000-0000-000000000006', 'ica_subhost', 1,
   '# ICA (Sub-Host) — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL),
  ('44444444-0000-0000-0000-000000000007', 'can_spam_addendum', 1,
   '# CAN-SPAM Addendum — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL),
  ('44444444-0000-0000-0000-000000000008', 'tcpa_addendum', 1,
   '# TCPA Addendum — v1\n\nPlaceholder content.',
   'Initial', NOW() - INTERVAL '180 days', NULL)
ON CONFLICT (document_type, version) DO NOTHING;
