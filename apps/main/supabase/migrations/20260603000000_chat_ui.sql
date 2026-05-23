-- §24 — Chat UI: tone matching configuration, hate-speech deny-list (tenant
-- supplemental), anonymous chat 3-identifier rate limit, authenticated
-- customer 3-tier chat rate limit with booking bonus + resolve function.
--
-- Builds on:
--   • BP11's platform_settings.supervisor_slur_deny_list (kept; this BP24
--     migration adds the tenant supplemental list, NOT a new platform list).
--   • BP21's tenant_settings table (extends with tone/memory/safety columns).
--   • BP12's customer_memories.rapport_tone_level (adds rapport_tone_directive).
--   • D-031 actual tier codes: byo_research / byo_professional / byo_agency /
--     sub_starter / sub_pro / sub_agency. Spec §24.9 SQL function refers to
--     `sub_host_pro`/`sub_host_agency` — those codes don't exist in
--     tier_definitions. Function uses real codes; documented in MEMORY D-057.
--
-- audit_log FK note: customer_chat_counters.hard_limit_summary_audit_id is a
-- bare UUID (audit_log table doesn't exist yet per D-036). TODO(audit-log-fk).

-- ──────────────────────────────────────────────────────────────────────────
-- 1. tenant_settings additions — §24.5 tone config + §24.5 supplemental
--    denylist + §24.11 memory indicator gate.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS persona_tone_max_level INTEGER NOT NULL DEFAULT 3
    CHECK (persona_tone_max_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS allow_profanity BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS slang_allow BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS supplemental_hate_speech_denylist JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS show_memory_indicators BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.tenant_settings.persona_tone_max_level IS
  '§24.5 ceiling on resolved chat tone (1=formal..5=matched energy). Default 3.';
COMMENT ON COLUMN public.tenant_settings.allow_profanity IS
  '§24.5 opt-in profanity (does not auto-enable at any tone level).';
COMMENT ON COLUMN public.tenant_settings.supplemental_hate_speech_denylist IS
  '§24.5 tenant Pro+ additive deny-list (cannot subtract from platform list).';
COMMENT ON COLUMN public.tenant_settings.show_memory_indicators IS
  '§24.11 toggle the "this response used memory" tooltip on persona avatars.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. customer_memories.rapport_tone_directive — §24.5 "cut the small talk".
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.customer_memories
  ADD COLUMN IF NOT EXISTS rapport_tone_directive TEXT
    CHECK (rapport_tone_directive IN ('direct'));

COMMENT ON COLUMN public.customer_memories.rapport_tone_directive IS
  '§24.5 "cut the small talk" / similar → "direct"; AI suppresses small talk.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. anonymous_chat_counters — §24.8 three-identifier limit.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.anonymous_chat_counters (
  identifier_type   TEXT        NOT NULL CHECK (identifier_type IN ('session','ip','fingerprint')),
  identifier_value  TEXT        NOT NULL,
  tenant_id         UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  current_count     INTEGER     NOT NULL DEFAULT 0,
  first_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  limit_hit_at      TIMESTAMPTZ,
  PRIMARY KEY (identifier_type, identifier_value, tenant_id)
);

CREATE INDEX anonymous_chat_counters_cleanup_idx
  ON public.anonymous_chat_counters(last_message_at);

CREATE INDEX anonymous_chat_counters_ip_burst_idx
  ON public.anonymous_chat_counters(identifier_type, identifier_value, limit_hit_at)
  WHERE identifier_type = 'ip' AND limit_hit_at IS NOT NULL;

ALTER TABLE public.anonymous_chat_counters ENABLE ROW LEVEL SECURITY;

-- Anonymous chat counters are read/written by service_role only — no end-user
-- visibility. The chat handler runs the increment + check via service-role.
CREATE POLICY anonymous_chat_counters_select_service ON public.anonymous_chat_counters
  FOR SELECT USING (FALSE);
CREATE POLICY anonymous_chat_counters_insert_service ON public.anonymous_chat_counters
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY anonymous_chat_counters_update_service ON public.anonymous_chat_counters
  FOR UPDATE USING (FALSE);
CREATE POLICY anonymous_chat_counters_delete_service ON public.anonymous_chat_counters
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_chat_counters TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. customer_chat_counters — §24.9 per-(customer, tenant) rolling 30d counter.
--    hard_limit_summary_audit_id is bare UUID (audit_log not yet created — D-036).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.customer_chat_counters (
  user_id                       UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tenant_id                     UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  current_count                 INTEGER     NOT NULL DEFAULT 0,
  last_message_at               TIMESTAMPTZ,
  soft1_last_issued_at          TIMESTAMPTZ,
  soft2_last_issued_at          TIMESTAMPTZ,
  hard_limit_hit_at             TIMESTAMPTZ,
  -- TODO(audit-log-fk): convert to FK when audit_log lands per D-036.
  hard_limit_summary_audit_id   UUID,
  resolved_soft1_cap            INTEGER,
  resolved_soft2_cap            INTEGER,
  resolved_hard_cap             INTEGER,
  resolved_booking_bonus_percent INTEGER,
  resolved_at                   TIMESTAMPTZ,
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX customer_chat_counters_recompute_idx
  ON public.customer_chat_counters(tenant_id, last_message_at);

ALTER TABLE public.customer_chat_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_chat_counters_select_own ON public.customer_chat_counters
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY customer_chat_counters_insert_service ON public.customer_chat_counters
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY customer_chat_counters_update_service ON public.customer_chat_counters
  FOR UPDATE USING (FALSE);
CREATE POLICY customer_chat_counters_delete_service ON public.customer_chat_counters
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.customer_chat_counters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_chat_counters TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. customer_chat_tenant_overrides — §24.9 Pro+ tier overrides.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.customer_chat_tenant_overrides (
  tenant_id              UUID        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  soft1_cap              INTEGER,
  soft2_cap              INTEGER,
  hard_cap               INTEGER,
  booking_bonus_percent  INTEGER,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id     UUID        REFERENCES public.users(id)
);

ALTER TABLE public.customer_chat_tenant_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY ccto_select_in_tenant ON public.customer_chat_tenant_overrides
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY ccto_insert_service ON public.customer_chat_tenant_overrides
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY ccto_update_service ON public.customer_chat_tenant_overrides
  FOR UPDATE USING (FALSE);
CREATE POLICY ccto_delete_service ON public.customer_chat_tenant_overrides
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.customer_chat_tenant_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_chat_tenant_overrides TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. resolve_customer_chat_caps — §24.9 cap resolution function.
--    SECURITY DEFINER, search_path=''. Uses ACTUAL tier_definitions codes
--    (D-031): Pro+ = sub_pro / sub_agency / byo_agency. Spec uses
--    'sub_host_pro' / 'sub_host_agency' which don't exist in the DB.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_customer_chat_caps(
  p_tenant_id UUID,
  p_user_id   UUID
) RETURNS TABLE (
  soft1_cap              INTEGER,
  soft2_cap              INTEGER,
  hard_cap               INTEGER,
  booking_bonus_percent  INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tier               TEXT;
  v_has_future_booking BOOLEAN;
  v_base_soft1         INTEGER;
  v_base_soft2         INTEGER;
  v_base_hard          INTEGER;
  v_bonus              INTEGER;
BEGIN
  -- 1. Tenant tier.
  SELECT td.code
    INTO v_tier
    FROM public.tenants t
    JOIN public.tier_definitions td ON t.tier_id = td.id
   WHERE t.id = p_tenant_id;

  -- 2. Override only if Pro+ tier. Actual seeded tier codes (D-031).
  IF v_tier IN ('sub_pro', 'sub_agency', 'byo_agency', 'byo_professional') THEN
    SELECT cco.soft1_cap, cco.soft2_cap, cco.hard_cap, cco.booking_bonus_percent
      INTO v_base_soft1, v_base_soft2, v_base_hard, v_bonus
      FROM public.customer_chat_tenant_overrides cco
     WHERE cco.tenant_id = p_tenant_id;
  END IF;

  -- 3. Fall back to platform defaults per missing column.
  IF v_base_soft1 IS NULL THEN
    SELECT (value::TEXT)::INTEGER INTO v_base_soft1
      FROM public.platform_settings WHERE key = 'customer_chat_soft1_cap';
  END IF;
  IF v_base_soft2 IS NULL THEN
    SELECT (value::TEXT)::INTEGER INTO v_base_soft2
      FROM public.platform_settings WHERE key = 'customer_chat_soft2_cap';
  END IF;
  IF v_base_hard IS NULL THEN
    SELECT (value::TEXT)::INTEGER INTO v_base_hard
      FROM public.platform_settings WHERE key = 'customer_chat_hard_cap';
  END IF;
  IF v_bonus IS NULL THEN
    SELECT (value::TEXT)::INTEGER INTO v_bonus
      FROM public.platform_settings WHERE key = 'customer_chat_booking_bonus_percent';
  END IF;

  -- 4. Future-dated booking check.
  -- bookings.sailing_date is on the booking row directly (BP15). booking_status
  -- enum has 'cancelled' but not 'no_show'/'refunded' (spec values that don't
  -- exist in the enum) — only 'cancelled' is filtered. 'sailed'/'completed'
  -- naturally fail the sailing_date >= NOW() predicate.
  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
     WHERE b.user_id = p_user_id
       AND b.tenant_id = p_tenant_id
       AND b.sailing_date >= CURRENT_DATE
       AND b.status <> 'cancelled'
  ) INTO v_has_future_booking;

  -- 5. Apply bonus (integer division — spec semantics).
  IF v_has_future_booking THEN
    soft1_cap             := v_base_soft1 + (v_base_soft1 * v_bonus / 100);
    soft2_cap             := v_base_soft2 + (v_base_soft2 * v_bonus / 100);
    hard_cap              := v_base_hard  + (v_base_hard  * v_bonus / 100);
    booking_bonus_percent := v_bonus;
  ELSE
    soft1_cap             := v_base_soft1;
    soft2_cap             := v_base_soft2;
    hard_cap              := v_base_hard;
    booking_bonus_percent := 0;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_customer_chat_caps(UUID, UUID) FROM public;
GRANT  EXECUTE ON FUNCTION public.resolve_customer_chat_caps(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_customer_chat_caps(UUID, UUID) IS
  '§24.9 single source of truth for per-(customer, tenant) chat cap resolution. SECURITY DEFINER + search_path=''''. Returns bonus-applied caps when customer has a future-dated unsailed/uncancelled booking in the tenant.';

-- ──────────────────────────────────────────────────────────────────────────
-- 7. platform_settings — seed all §24.5/§24.8/§24.9 knobs.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.platform_settings (key, value, description) VALUES
  -- §24.2 disclosure
  ('chat_ai_disclosure_text', '"AI-assisted chat — your conversations are reviewed for quality"'::JSONB,
   '§24.2 persistent chat banner text'),

  -- §24.8 anonymous limits (normal)
  ('anon_chat_limit_per_session',                '5'::JSONB,  '§24.8 per-session anonymous chat cap'),
  ('anon_chat_limit_per_ip_24h',                 '15'::JSONB, '§24.8 per-IP 24h rolling cap'),
  ('anon_chat_limit_per_fingerprint_24h',        '10'::JSONB, '§24.8 per-fingerprint 24h rolling cap'),
  -- §24.8 anonymous limits (under abuse — platform-admin-toggled per tenant; defaults here are floors)
  ('anon_chat_limit_per_session_under_abuse',    '2'::JSONB,  '§24.8 reduced per-session cap under abuse'),
  ('anon_chat_limit_per_ip_under_abuse',         '5'::JSONB,  '§24.8 reduced per-IP cap under abuse'),
  ('anon_chat_limit_per_fingerprint_under_abuse','3'::JSONB,  '§24.8 reduced per-fingerprint cap under abuse'),

  -- §24.9 customer 3-tier caps
  ('customer_chat_soft1_cap',                  '20'::JSONB,  '§24.9 default soft1 message cap (30d window)'),
  ('customer_chat_soft2_cap',                  '30'::JSONB,  '§24.9 default soft2 message cap'),
  ('customer_chat_hard_cap',                   '40'::JSONB,  '§24.9 default hard cap'),
  ('customer_chat_booking_bonus_percent',      '100'::JSONB, '§24.9 default future-booking bonus (0-400)'),
  ('customer_chat_limit_hard_ceiling',         '200'::JSONB, '§24.9 platform-enforced max for hard_cap (Pro+ override range)'),
  ('customer_chat_limit_hard_floor',           '15'::JSONB,  '§24.9 platform-enforced min for hard_cap'),
  ('customer_chat_window_days',                '30'::JSONB,  '§24.9 rolling counter window in days'),
  ('customer_chat_soft1_cooldown_days',        '7'::JSONB,   '§24.9 days between soft1 nudges'),
  ('customer_chat_soft2_cooldown_days',        '3'::JSONB,   '§24.9 days between soft2 warnings'),

  -- §24.9 persona prompt augmentation text (configurable without code deploy)
  ('customer_chat_soft1_persona_prompt',
   '"Note for this turn: this customer has been chatting actively with you over the past few weeks. Without seeming pushy, gently encourage focusing on a specific cruise to book. Suggest you''d be happy to put together a detailed quote on a sailing they''re seriously considering. Keep your normal personality and warmth."'::JSONB,
   '§24.9 Soft1 in-character persona augmentation'),
  ('customer_chat_soft2_persona_prompt',
   '"Note for this turn: this customer has had extensive chat time with you and hasn''t booked yet. Be more direct (still warm and in-character) about the conversation track. Mention that without finding a cruise that works, you won''t be able to keep chatting indefinitely, and offer specific next steps."'::JSONB,
   '§24.9 Soft2 in-character persona augmentation')

ON CONFLICT (key) DO NOTHING;
