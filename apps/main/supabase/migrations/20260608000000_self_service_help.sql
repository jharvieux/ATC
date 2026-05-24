-- BP31 §32 — Self-Service Help (Phase 1 schema).
-- Four tables: help_sessions, bug_submissions, feature_requests, help_doc_versions.
-- All RLS-enabled per §32.5.5.

-- ── help_sessions ───────────────────────────────────────────────────────────
CREATE TABLE public.help_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id),
  user_id             UUID NOT NULL REFERENCES public.users(id),
  session_type        TEXT NOT NULL CHECK (session_type IN ('help','bug','feature')),
  source_surface      TEXT NOT NULL CHECK (source_surface IN ('admin','customer_chat')),
  conversation_id     UUID,            -- references public.conversations(id); kept FK-less to avoid create-order coupling
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  outcome             TEXT CHECK (outcome IN ('resolved','submitted','escalated','abandoned')),
  ai_messages_count   INTEGER DEFAULT 0,
  escalated_to_human  BOOLEAN DEFAULT FALSE,
  escalation_reason   TEXT
);

CREATE INDEX help_sessions_tenant_idx ON public.help_sessions(tenant_id);
CREATE INDEX help_sessions_user_idx   ON public.help_sessions(user_id);
CREATE INDEX help_sessions_type_idx   ON public.help_sessions(tenant_id, session_type, started_at DESC);

-- ── bug_submissions ─────────────────────────────────────────────────────────
CREATE TABLE public.bug_submissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  help_session_id       UUID NOT NULL REFERENCES public.help_sessions(id),
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id),
  submitter_user_id     UUID NOT NULL REFERENCES public.users(id),
  source_type           TEXT NOT NULL CHECK (source_type IN ('tenant_admin','tenant_agent','customer')),

  -- Structured fields (gathered by Help AI; redacted of PII per §32.7.6)
  where_in_platform     TEXT,
  actual_behavior       TEXT,
  expected_behavior     TEXT,
  steps_to_reproduce    TEXT,
  frequency             TEXT CHECK (frequency IN ('always','sometimes','once','unknown')),
  browser_info          JSONB,
  screenshots           JSONB,  -- array of storage URLs

  -- Quality scoring
  confidence_score      NUMERIC(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  confidence_factors    JSONB,

  -- GitHub linkage
  github_issue_number   INTEGER,
  github_issue_url      TEXT,
  github_issue_state    TEXT CHECK (github_issue_state IN ('pending','open','closed','failed','quarantined')),
  github_creation_error TEXT,
  quarantine_reason     TEXT,

  -- Triage and lifecycle (per §32.9 interactive triage outcomes)
  submitted_at          TIMESTAMPTZ DEFAULT NOW(),
  triage_state          TEXT NOT NULL DEFAULT 'untriaged'
    CHECK (triage_state IN ('untriaged','confirmed','unconfirmed','needs_human_fix')),
  closed_at             TIMESTAMPTZ,
  resolution_summary    TEXT
);

CREATE INDEX bug_submissions_tenant_idx ON public.bug_submissions(tenant_id);
CREATE INDEX bug_submissions_state_idx  ON public.bug_submissions(github_issue_state, submitted_at DESC);

-- ── feature_requests ────────────────────────────────────────────────────────
CREATE TABLE public.feature_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  help_session_id     UUID NOT NULL REFERENCES public.help_sessions(id),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id),
  submitter_user_id   UUID NOT NULL REFERENCES public.users(id),
  source_type         TEXT NOT NULL CHECK (source_type IN ('tenant_admin','tenant_agent','customer')),

  what                     TEXT,
  why                      TEXT,
  current_workaround       TEXT,
  expected_usage_frequency TEXT,

  github_issue_number INTEGER,
  github_issue_url    TEXT,
  github_issue_state  TEXT CHECK (github_issue_state IN ('pending','open','closed','failed','quarantined')),

  submitted_at        TIMESTAMPTZ DEFAULT NOW(),
  decision            TEXT CHECK (decision IN ('accepted','rejected','deferred','duplicate')),
  decision_notes      TEXT,
  decided_at          TIMESTAMPTZ
);

CREATE INDEX feature_requests_tenant_idx   ON public.feature_requests(tenant_id);
CREATE INDEX feature_requests_decision_idx ON public.feature_requests(decision, submitted_at DESC);

-- ── help_doc_versions ───────────────────────────────────────────────────────
-- Caches generated PDF/.docx exports keyed by code version + (optionally) tenant.
CREATE TABLE public.help_doc_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_version  TEXT NOT NULL,
  tenant_id     UUID REFERENCES public.tenants(id),  -- NULL = platform-wide
  format        TEXT NOT NULL CHECK (format IN ('pdf','docx')),
  storage_path  TEXT NOT NULL,
  size_bytes    BIGINT,
  generated_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  UNIQUE NULLS NOT DISTINCT (code_version, tenant_id, format)
);

CREATE INDEX help_doc_versions_expiry_idx ON public.help_doc_versions(expires_at);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.help_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bug_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_doc_versions ENABLE ROW LEVEL SECURITY;

-- help_sessions: tenant-scoped CRUD for members of the tenant.
CREATE POLICY help_sessions_tenant_select ON public.help_sessions
  FOR SELECT USING (public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_sessions_tenant_insert ON public.help_sessions
  FOR INSERT WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_sessions_tenant_update ON public.help_sessions
  FOR UPDATE USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_sessions_tenant_delete ON public.help_sessions
  FOR DELETE USING (public.auth_user_in_tenant(tenant_id));

-- bug_submissions: tenant-scoped; PLUS customer access to own rows.
CREATE POLICY bug_submissions_tenant_select ON public.bug_submissions
  FOR SELECT USING (public.auth_user_in_tenant(tenant_id));
CREATE POLICY bug_submissions_customer_self ON public.bug_submissions
  FOR SELECT USING (submitter_user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY bug_submissions_tenant_insert ON public.bug_submissions
  FOR INSERT WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY bug_submissions_tenant_update ON public.bug_submissions
  FOR UPDATE USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY bug_submissions_tenant_delete ON public.bug_submissions
  FOR DELETE USING (public.auth_user_in_tenant(tenant_id));

-- feature_requests: same shape as bug_submissions.
CREATE POLICY feature_requests_tenant_select ON public.feature_requests
  FOR SELECT USING (public.auth_user_in_tenant(tenant_id));
CREATE POLICY feature_requests_customer_self ON public.feature_requests
  FOR SELECT USING (submitter_user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY feature_requests_tenant_insert ON public.feature_requests
  FOR INSERT WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY feature_requests_tenant_update ON public.feature_requests
  FOR UPDATE USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY feature_requests_tenant_delete ON public.feature_requests
  FOR DELETE USING (public.auth_user_in_tenant(tenant_id));

-- help_doc_versions: tenant-scoped if tenant_id IS NOT NULL; platform-wide read
-- if tenant_id IS NULL (the default-branding cached export every tenant can use).
CREATE POLICY help_doc_versions_select ON public.help_doc_versions
  FOR SELECT USING (tenant_id IS NULL OR public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_doc_versions_insert ON public.help_doc_versions
  FOR INSERT WITH CHECK (tenant_id IS NULL OR public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_doc_versions_update ON public.help_doc_versions
  FOR UPDATE USING (tenant_id IS NULL OR public.auth_user_in_tenant(tenant_id))
  WITH CHECK (tenant_id IS NULL OR public.auth_user_in_tenant(tenant_id));
CREATE POLICY help_doc_versions_delete ON public.help_doc_versions
  FOR DELETE USING (tenant_id IS NULL OR public.auth_user_in_tenant(tenant_id));
