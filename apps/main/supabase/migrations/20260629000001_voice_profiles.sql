-- #903 / D-193 — Phase 2 voice profiles: per-user writing samples + extracted
-- style card so the Phase 3 draft composer can write in the TA's own voice.
--
-- Two tables, both tenant-scoped (RLS + app-layer filter):
--
--   voice_samples — individual email excerpts pasted by TAs. user_id=NULL
--     means the tenant owner's "house style" default (inherited by members
--     who haven't added their own samples).
--
--   voice_profiles — the extracted style card computed from the samples.
--     content_hash covers the sample bodies; unchanged samples never re-bill.
--     user_id=NULL = house style card (mirrors voice_samples scope).
--
-- Deletions: service-role only (RLS DELETE=false). The API deletes via the
-- service-role client after asserting ownership in app code (D-091 two-layer).

-- ─── voice_samples ───────────────────────────────────────────────────────────

CREATE TABLE public.voice_samples (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  -- NULL = tenant house-style sample set by the owner.
  -- Non-null = individual TA's personal sample.
  user_id      TEXT        NULL,
  body         TEXT        NOT NULL CHECK (char_length(body) BETWEEN 50 AND 8000),
  source_label TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.voice_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_samples_select_policy" ON public.voice_samples
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY "voice_samples_insert_policy" ON public.voice_samples
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- Deletes go through the API which uses service-role after app-layer ownership check.
CREATE POLICY "voice_samples_delete_policy" ON public.voice_samples
  FOR DELETE TO PUBLIC
  USING (false);

CREATE POLICY "voice_samples_update_policy" ON public.voice_samples
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE INDEX voice_samples_tenant_user_idx
  ON public.voice_samples (tenant_id, user_id);

COMMENT ON TABLE public.voice_samples IS
  'Email excerpts pasted by TAs for voice-profile extraction (#903). '
  'user_id=NULL = tenant house-style (set by owner). Populated via the '
  'settings UI; deletion is service-role only.';

-- ─── voice_profiles ──────────────────────────────────────────────────────────

CREATE TABLE public.voice_profiles (
  tenant_id     TEXT        NOT NULL,
  -- NULL = tenant house-style profile. Non-null = individual TA's card.
  user_id       TEXT        NULL,
  -- Compact style card produced by the extraction job (JSONB for flexibility).
  -- Shape: { greeting, signoff, formality, rhythm, signature_phrases, emoji_habits, bad_news }
  style_card    JSONB       NOT NULL DEFAULT '{}',
  -- SHA-256 hex of the sorted sample bodies at extraction time. If the samples
  -- haven't changed, the extraction job skips the Anthropic call.
  samples_hash  TEXT        NOT NULL DEFAULT '',
  extracted_at  TIMESTAMPTZ NULL,
  -- Allows the TA to override the extracted card with a free-text summary.
  card_override TEXT        NULL,
  PRIMARY KEY (tenant_id, COALESCE(user_id, ''))
);

ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_profiles_select_policy" ON public.voice_profiles
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY "voice_profiles_insert_policy" ON public.voice_profiles
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY "voice_profiles_update_policy" ON public.voice_profiles
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY "voice_profiles_delete_policy" ON public.voice_profiles
  FOR DELETE TO PUBLIC
  USING (false);

COMMENT ON TABLE public.voice_profiles IS
  'Extracted writing-style card for a TA or tenant house style (#903). '
  'Keyed by (tenant_id, user_id) — user_id=NULL means house style. '
  'The extraction Inngest job populates style_card + samples_hash. '
  'card_override lets the TA correct the auto-extracted card.';

COMMENT ON COLUMN public.voice_profiles.samples_hash IS
  'SHA-256 hex of sorted sample body text at last extraction. '
  'Used by the extraction job to skip unchanged sample sets.';
