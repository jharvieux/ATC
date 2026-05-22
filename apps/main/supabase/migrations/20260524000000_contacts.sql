-- §12.1 — Contacts table.
-- Not all contacts are platform users (user_id nullable per spec).
-- RLS: standard four-policy set.

CREATE TABLE public.contacts (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID         NOT NULL REFERENCES public.tenants(id),
  user_id                   UUID         REFERENCES public.users(id),  -- nullable; not all contacts are platform users

  -- Identity
  first_name                TEXT,
  last_name                 TEXT,
  middle_name               TEXT,
  preferred_name            TEXT,
  email                     TEXT,
  phone                     TEXT,

  -- Demographics
  date_of_birth             DATE,
  date_of_birth_is_estimated BOOLEAN     DEFAULT FALSE,
  estimation_basis          TEXT,
  gender                    TEXT,
  nationality               TEXT,

  -- Travel-relevant
  passport_expiry           DATE,
  loyalty_programs          JSONB,
  dietary_restrictions      TEXT,
  accessibility_needs       TEXT,

  -- Source
  source                    TEXT,           -- 'manual','ai_extracted','signup','imported','referred'
  source_reference          TEXT,

  -- Audit
  created_by_user_id        UUID         REFERENCES public.users(id),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX contacts_tenant_idx  ON public.contacts(tenant_id);
CREATE INDEX contacts_email_idx   ON public.contacts(tenant_id, email);
CREATE INDEX contacts_name_idx    ON public.contacts(tenant_id, last_name, first_name);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_select_policy ON public.contacts
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY contacts_insert_policy ON public.contacts
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY contacts_update_policy ON public.contacts
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY contacts_delete_policy ON public.contacts
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO service_role;
