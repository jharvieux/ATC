-- BP30 §30.4 fixture: tenants + the tier_definitions seed they depend on.
--
-- Skeletal coverage:
--   - 4 tier_definitions rows (sub_starter, sub_pro, sub_agency, byo_research,
--     byo_professional, byo_agency) — codes match the §3.3 tier ladder
--     referenced by lib/abuse/revenue.ts.
--   - 1 platform tenant (always exists; sentinel id used by lib/ai/call-wrapper.ts
--     for genuinely cross-tenant attribution).
--   - 2 BYO-host tenants (byohost_a, byohost_b) at different tiers and billing periods.
--   - 2 sub-host tenants (subhost_a, subhost_b) at different tiers and billing periods.
--
-- Idempotent: ON CONFLICT DO NOTHING so re-running against a populated test DB
-- doesn't error. Fixed UUIDs so other fixture files can reference them.

-- ── tier_definitions ────────────────────────────────────────────────────────
INSERT INTO public.tier_definitions (id, code, display_name) VALUES
  ('11111111-0000-0000-0000-000000000001', 'sub_starter',      'Sub-Host Starter'),
  ('11111111-0000-0000-0000-000000000002', 'sub_pro',          'Sub-Host Pro'),
  ('11111111-0000-0000-0000-000000000003', 'sub_agency',       'Sub-Host Agency'),
  ('11111111-0000-0000-0000-000000000004', 'byo_research',     'BYO Research'),
  ('11111111-0000-0000-0000-000000000005', 'byo_professional', 'BYO Professional'),
  ('11111111-0000-0000-0000-000000000006', 'byo_agency',       'BYO Agency')
ON CONFLICT (code) DO NOTHING;

-- ── tenants ─────────────────────────────────────────────────────────────────
-- The platform tenant must exist with the all-zero UUID per D-060 (call-wrapper
-- sentinel for cross-tenant attribution).
INSERT INTO public.tenants (
  id, slug, display_name, legal_name, tenant_type, status,
  tier_id, seat_count, billing_period, ai_mode, is_sandbox,
  signup_completed_at, activated_at
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    'platform',
    'AI Travel Concierge Platform',
    'AI Travel Concierge Platform LLC',
    'platform',
    'active',
    NULL, 1, 'monthly', 'autonomous', FALSE,
    NOW() - INTERVAL '365 days',
    NOW() - INTERVAL '365 days'
  ),
  (
    '22222222-0000-0000-0000-00000000000a',
    'byohost-a',
    'BYO Host A Travel',
    'BYO Host A Travel LLC',
    'byo_host',
    'active',
    '11111111-0000-0000-0000-000000000005', -- byo_professional
    3, 'monthly', 'autonomous', FALSE,
    NOW() - INTERVAL '90 days',
    NOW() - INTERVAL '89 days'
  ),
  (
    '22222222-0000-0000-0000-00000000000b',
    'byohost-b',
    'BYO Host B Cruises',
    'BYO Host B Cruises LLC',
    'byo_host',
    'active',
    '11111111-0000-0000-0000-000000000006', -- byo_agency
    7, 'annual', 'draft_only', FALSE,
    NOW() - INTERVAL '180 days',
    NOW() - INTERVAL '178 days'
  ),
  (
    '33333333-0000-0000-0000-00000000000a',
    'subhost-a',
    'Sub Host A',
    'Sub Host A LLC',
    'sub_host',
    'active',
    '11111111-0000-0000-0000-000000000001', -- sub_starter
    1, 'monthly', 'autonomous', TRUE,        -- sandbox tenant
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '29 days'
  ),
  (
    '33333333-0000-0000-0000-00000000000b',
    'subhost-b',
    'Sub Host B',
    'Sub Host B LLC',
    'sub_host',
    'active',
    '11111111-0000-0000-0000-000000000002', -- sub_pro
    5, 'annual', 'autonomous', FALSE,
    NOW() - INTERVAL '60 days',
    NOW() - INTERVAL '59 days'
  )
ON CONFLICT (id) DO NOTHING;
