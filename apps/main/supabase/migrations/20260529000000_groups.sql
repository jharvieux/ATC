-- §18.1–18.10 — Group bookings: lifecycle, invitations, HMAC token contract,
-- destination images, email log for rate-limit enforcement.

-- ── destination_images ────────────────────────────────────────────────────────
-- Operator-populated library of destination photos.
CREATE TABLE public.destination_images (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  destination TEXT    NOT NULL,
  tags        TEXT[],
  image_url   TEXT    NOT NULL,
  license_info TEXT
);

CREATE INDEX destination_images_destination_idx ON public.destination_images(destination);

-- ── destination_images_cache ──────────────────────────────────────────────────
-- AI-generated images cached by (destination, cruise_line) to avoid re-generation.
CREATE TABLE public.destination_images_cache (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination TEXT        NOT NULL,
  cruise_line TEXT        NOT NULL,
  image_url   TEXT        NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (destination, cruise_line)
);

-- ── email_log ─────────────────────────────────────────────────────────────────
-- Cross-tenant log for per-recipient email rate-limit enforcement. §18.8.
CREATE TABLE public.email_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email TEXT        NOT NULL,
  template_name   TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id       UUID        REFERENCES public.tenants(id) ON DELETE SET NULL
);

CREATE INDEX email_log_recipient_sent_idx ON public.email_log(recipient_email, sent_at);

-- ── groups ────────────────────────────────────────────────────────────────────
-- Per §18.1–18.2 group lifecycle.
CREATE TABLE public.groups (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  coordinator_user_id   UUID        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status                TEXT        NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','active','closed','sailed','cancelled')),
  cruise_line           TEXT        NOT NULL,
  ship_name             TEXT        NOT NULL,
  sailing_date          DATE        NOT NULL,
  departure_port        TEXT        NOT NULL,
  max_cabins            INTEGER,
  target_group_rate_cents BIGINT,
  coordinator_message   TEXT,
  visibility_default    TEXT        NOT NULL DEFAULT 'visible'
    CHECK (visibility_default IN ('visible','hidden')),
  hero_image_url        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  sailed_at             TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ
);

CREATE INDEX groups_tenant_idx  ON public.groups(tenant_id);
CREATE INDEX groups_status_idx  ON public.groups(status);
CREATE INDEX groups_sailing_idx ON public.groups(sailing_date);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY groups_select ON public.groups
  FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY groups_insert ON public.groups
  FOR INSERT WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY groups_update ON public.groups
  FOR UPDATE USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY groups_delete ON public.groups
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.groups TO service_role;

-- ── invitations ───────────────────────────────────────────────────────────────
-- Per §18.2 / §18.5 / §18.9 — per-invitee invitation with HMAC token lifecycle.
CREATE TABLE public.invitations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id              UUID        NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  invitee_email         TEXT        NOT NULL,
  invitee_name          TEXT,
  personal_note         TEXT,
  token                 TEXT        NOT NULL UNIQUE,
  visibility_choice     TEXT        NOT NULL DEFAULT 'no_opinion'
    CHECK (visibility_choice IN ('no_opinion','be_anonymous','show_me_anyway')),
  rsvp_state            TEXT        NOT NULL DEFAULT 'pending'
    CHECK (rsvp_state IN ('pending','interested','not_going','booked')),
  -- §18.5 token lifecycle columns
  token_revoked_at      TIMESTAMPTZ,
  token_revoked_reason  TEXT
    CHECK (token_revoked_reason IN (
      'invitee_removed','coordinator_revoked','first_use_authenticated',
      'suspected_compromise','expired_natural'
    )),
  token_first_used_at   TIMESTAMPTZ,
  token_bound_email     TEXT,
  -- email cadence
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_email_sent_at    TIMESTAMPTZ
);

-- §18.5 — active-token lookup (WHERE clause prunes revoked rows from the index).
CREATE INDEX invitations_token_lookup_idx ON public.invitations(token)
  WHERE token_revoked_at IS NULL;
CREATE INDEX invitations_group_state_idx  ON public.invitations(group_id, rsvp_state);
CREATE INDEX invitations_group_pending_idx ON public.invitations(group_id)
  WHERE rsvp_state = 'pending' AND token_revoked_at IS NULL;

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY invitations_select ON public.invitations
  FOR SELECT USING (
    group_id IN (SELECT id FROM public.groups
                 WHERE tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()))
  );
CREATE POLICY invitations_insert ON public.invitations
  FOR INSERT WITH CHECK (
    group_id IN (SELECT id FROM public.groups
                 WHERE tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()))
  );
CREATE POLICY invitations_update ON public.invitations
  FOR UPDATE USING (
    group_id IN (SELECT id FROM public.groups
                 WHERE tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()))
  );
CREATE POLICY invitations_delete ON public.invitations
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.invitations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO service_role;
