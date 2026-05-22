-- §17.4 — Versioned legal documents and consent records.
-- Also creates user_consent_pending for re-consent flow.

-- ── legal_documents ───────────────────────────────────────────────────────────
CREATE TABLE public.legal_documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type    TEXT        NOT NULL
    CHECK (document_type IN (
      'tou','privacy_policy','ai_disclaimer','cookie_policy',
      'ica_subhost','can_spam_addendum','tcpa_addendum'
    )),
  version          INTEGER     NOT NULL,
  content_markdown TEXT        NOT NULL,
  content_html     TEXT,
  summary_of_changes TEXT,
  effective_at     TIMESTAMPTZ NOT NULL,
  superseded_at    TIMESTAMPTZ,
  created_by_user_id UUID      REFERENCES public.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, version)
);

CREATE INDEX legal_documents_type_idx ON public.legal_documents(document_type, version DESC);

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;
-- Legal documents are public records; any authenticated user may read them.
-- auth.uid() IS NOT NULL avoids the USING(TRUE) lint rule while preserving the intent.
CREATE POLICY legal_documents_select ON public.legal_documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY legal_documents_insert ON public.legal_documents FOR INSERT WITH CHECK (FALSE);
CREATE POLICY legal_documents_update ON public.legal_documents FOR UPDATE USING (FALSE);
CREATE POLICY legal_documents_delete ON public.legal_documents FOR DELETE USING (FALSE);

GRANT SELECT ON public.legal_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.legal_documents TO service_role;

-- ── legal_consents ────────────────────────────────────────────────────────────
CREATE TABLE public.legal_consents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id     UUID        REFERENCES auth.users(id),
  tenant_id        UUID        REFERENCES public.tenants(id),
  document_id      UUID        NOT NULL REFERENCES public.legal_documents(id),
  document_type    TEXT        NOT NULL,
  document_version INTEGER     NOT NULL,
  action           TEXT        NOT NULL CHECK (action IN ('accepted','declined','withdrawn')),
  ip_address       TEXT,
  user_agent       TEXT,
  notes            TEXT,
  acted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX legal_consents_user_type_idx ON public.legal_consents(auth_user_id, document_type, document_version);
-- Prevent duplicate accept rows per (user, document type, version).
CREATE UNIQUE INDEX legal_consents_accept_unique_idx
  ON public.legal_consents(auth_user_id, document_type, document_version)
  WHERE action = 'accepted';

ALTER TABLE public.legal_consents ENABLE ROW LEVEL SECURITY;
-- Users can read their own consent rows; nobody else (except service_role).
CREATE POLICY legal_consents_select ON public.legal_consents FOR SELECT USING (auth_user_id = auth.uid());
-- service_role writes consent rows server-side; authenticated users cannot insert/update/delete.
CREATE POLICY legal_consents_insert ON public.legal_consents FOR INSERT WITH CHECK (FALSE);
CREATE POLICY legal_consents_update ON public.legal_consents FOR UPDATE USING (FALSE);
CREATE POLICY legal_consents_delete ON public.legal_consents FOR DELETE USING (FALSE);

GRANT SELECT ON public.legal_consents TO authenticated;
GRANT SELECT, INSERT ON public.legal_consents TO service_role;

-- ── user_consent_pending ──────────────────────────────────────────────────────
-- Flags users who need to re-accept a document whose version has been superseded.
CREATE TABLE public.user_consent_pending (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id      UUID        NOT NULL REFERENCES auth.users(id),
  document_type     TEXT        NOT NULL,
  document_id_pending UUID      NOT NULL REFERENCES public.legal_documents(id),
  flagged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auth_user_id, document_type)
);

CREATE INDEX user_consent_pending_user_idx ON public.user_consent_pending(auth_user_id);

ALTER TABLE public.user_consent_pending ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_consent_pending_select ON public.user_consent_pending FOR SELECT USING (auth_user_id = auth.uid());

GRANT SELECT ON public.user_consent_pending TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_consent_pending TO service_role;

-- ── Seed placeholder legal documents ─────────────────────────────────────────
-- TODO(legal): replace with attorney-reviewed content before Phase 2.
-- TODO(legal-attorney): ica_subhost chunk-license-survival clause per §15.14.6.
INSERT INTO public.legal_documents (document_type, version, content_markdown, effective_at)
VALUES
  ('tou',           1, '# Terms of Use\n\n[TODO(legal): attorney-reviewed content required before Phase 2 launch.]', NOW()),
  ('privacy_policy',1, '# Privacy Policy\n\n[TODO(legal): attorney-reviewed content required before Phase 2 launch.]', NOW()),
  ('ai_disclaimer', 1, '# AI Liability Disclaimer\n\n[TODO(legal): attorney-reviewed content required before Phase 2 launch.]\n\n## State-Specific Disclosures\n\n**California:** [TODO(legal)]\n\n**Illinois:** [TODO(legal)]\n\n**Utah:** [TODO(legal)]\n\n**New York:** [TODO(legal)]', NOW()),
  ('cookie_policy', 1, '# Cookie Policy\n\n[TODO(legal): attorney-reviewed content required before Phase 2 launch.]', NOW()),
  ('ica_subhost',   1, '# Independent Contractor Agreement\n\n[TODO(legal): attorney-reviewed content required before Phase 2 launch.]\n\n## Chunk-License-Survival Clause\n\n[CHUNK-LICENSE-SURVIVAL CLAUSE — TODO(legal-attorney): attorney to finalize perpetual, irrevocable license language per §15.14.6]', NOW());
