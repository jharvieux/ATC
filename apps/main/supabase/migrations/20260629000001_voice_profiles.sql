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
-- Uniqueness for voice_profiles: two partial unique indexes (one per scope)
-- rather than an expression PK, so app code can use explicit insert-or-update
-- without hitting PostgREST's onConflict expression-index limitations.

-- ─── voice_samples ───────────────────────────────────────────────────────────

CREATE TABLE public.voice_samples (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
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
  'user_id=NULL = tenant house-style (set by owner). Deletion is service-role only.';

-- ─── voice_profiles ──────────────────────────────────────────────────────────

CREATE TABLE public.voice_profiles (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  user_id       TEXT        NULL,
  style_card    JSONB       NOT NULL DEFAULT '{}',
  samples_hash  TEXT        NOT NULL DEFAULT '',
  extracted_at  TIMESTAMPTZ NULL,
  card_override TEXT        NULL
);

ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;

-- Two partial unique indexes enforce one-per-scope:
--   Per-user rows: unique (tenant_id, user_id) where user_id IS NOT NULL
--   House-style:   unique (tenant_id) where user_id IS NULL
CREATE UNIQUE INDEX voice_profiles_per_user_ux
  ON public.voice_profiles (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX voice_profiles_house_ux
  ON public.voice_profiles (tenant_id)
  WHERE user_id IS NULL;

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
  'user_id=NULL = house style. Extraction Inngest job populates style_card + '
  'samples_hash. card_override lets the TA correct the auto-extracted card.';

COMMENT ON COLUMN public.voice_profiles.samples_hash IS
  'SHA-256 hex of sorted sample body text at last extraction. '
  'Used to skip re-extraction when samples are unchanged.';
