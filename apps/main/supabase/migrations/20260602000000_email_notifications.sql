-- §23 — Email log, suppressions, pre-cruise content, port info, in-app notifications.
--
-- Replaces the provisional email_log table from 20260529000000_groups.sql with
-- the full §23.2 schema. The provisional table had only 4 columns
-- (recipient_email, template_name, sent_at, tenant_id) and no RLS.
-- group-reminder-cadence.ts is updated in this PR to use the new column names.
--
-- GRANT note (D-032 / D-039): every table here gets explicit grants to
-- 'authenticated' and 'service_role' because Supabase provisioning doesn't
-- set ALTER DEFAULT PRIVILEGES on this project.

-- ── Drop provisional email_log (BP19 stub) ───────────────────────────────────
DROP INDEX IF EXISTS public.email_log_recipient_sent_idx;
DROP TABLE IF EXISTS public.email_log;

-- ── email_log — §23.2 ─────────────────────────────────────────────────────────
CREATE TABLE public.email_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  user_id             UUID        REFERENCES public.users(id),
  -- contact_id deferred: contacts table lands in a future BP. TODO(contacts-fk)
  contact_id          UUID,
  to_email            TEXT        NOT NULL,
  from_email          TEXT        NOT NULL,
  reply_to            TEXT,
  subject             TEXT        NOT NULL,
  template_id         TEXT        NOT NULL,
  template_version    INTEGER,
  template_variables  JSONB,
  -- Provider
  resend_message_id   TEXT        UNIQUE,
  -- Status
  status              TEXT        NOT NULL CHECK (status IN (
    'queued','sent','delivered','soft_bounced','hard_bounced',
    'complained','rejected','suppressed'
  )),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,
  bounce_reason       TEXT,
  -- Categorization
  email_category      TEXT CHECK (email_category IN (
    'transactional','marketing','pre_cruise','group_invitation'
  )),
  -- related_booking_id: bookings table exists from BP20
  related_booking_id  UUID        REFERENCES public.bookings(id),
  -- related_group_id: groups table exists from BP19 (spec calls it group_bookings; real table is groups)
  related_group_id    UUID        REFERENCES public.groups(id),
  -- Audit
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes per §23.2 spec
CREATE INDEX email_log_rate_limit_idx    ON public.email_log(tenant_id, to_email, sent_at);
CREATE INDEX email_log_resend_lookup_idx ON public.email_log(resend_message_id) WHERE resend_message_id IS NOT NULL;

-- RLS — tenant-scoped read; writes are service_role only (webhook + send helper).
ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_log_select ON public.email_log
  FOR SELECT USING (auth.uid() IS NOT NULL AND tenant_id IN (
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
  ));

-- No INSERT/UPDATE/DELETE for authenticated role — service_role only.
CREATE POLICY email_log_insert_service ON public.email_log
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY email_log_update_service ON public.email_log
  FOR UPDATE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_log TO service_role;
GRANT SELECT ON public.email_log TO authenticated;

-- ── email_suppressions — §23.2 ────────────────────────────────────────────────
CREATE TABLE public.email_suppressions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES public.tenants(id),
  email_address  TEXT        NOT NULL,
  reason         TEXT        NOT NULL CHECK (reason IN (
    'hard_bounce','complaint','unsubscribe_all',
    'unsubscribe_marketing','unsubscribe_travel_news'
  )),
  suppressed_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, email_address, reason)
);

CREATE INDEX email_suppressions_lookup_idx
  ON public.email_suppressions(tenant_id, email_address, reason);

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_suppressions_select ON public.email_suppressions
  FOR SELECT USING (auth.uid() IS NOT NULL AND tenant_id IN (
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
  ));
CREATE POLICY email_suppressions_insert_service ON public.email_suppressions
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY email_suppressions_update_service ON public.email_suppressions
  FOR UPDATE USING (FALSE);
CREATE POLICY email_suppressions_delete_service ON public.email_suppressions
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_suppressions TO service_role;
GRANT SELECT ON public.email_suppressions TO authenticated;

-- ── pre_cruise_email_content — §23.4 ─────────────────────────────────────────
CREATE TABLE public.pre_cruise_email_content (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES public.tenants(id),
  -- booking_id: bookings table from BP20
  booking_id        UUID        NOT NULL REFERENCES public.bookings(id),
  -- contact_id: contacts table deferred. TODO(contacts-fk)
  contact_id        UUID        NOT NULL,
  email_phase       TEXT        NOT NULL CHECK (email_phase IN ('t_90','t_30','t_7','t_1')),
  generated_content JSONB       NOT NULL,
  companion_page_url TEXT,
  generated_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_at           TIMESTAMPTZ,
  UNIQUE (booking_id, email_phase)
);

ALTER TABLE public.pre_cruise_email_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY pce_content_select ON public.pre_cruise_email_content
  FOR SELECT USING (auth.uid() IS NOT NULL AND tenant_id IN (
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
  ));
CREATE POLICY pce_content_insert_service ON public.pre_cruise_email_content
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY pce_content_update_service ON public.pre_cruise_email_content
  FOR UPDATE USING (FALSE);
CREATE POLICY pce_content_delete_service ON public.pre_cruise_email_content
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pre_cruise_email_content TO service_role;
GRANT SELECT ON public.pre_cruise_email_content TO authenticated;

-- ── port_info_chunks — §23.4 seed table ──────────────────────────────────────
-- RAG seed for 17 North American departure ports. Content is operator task;
-- shipped with TODO(content) placeholders per build prompt §23 Task 7.
CREATE TABLE public.port_info_chunks (
  port_code            TEXT        PRIMARY KEY,  -- IATA-style (e.g. 'MIA', 'PCV')
  port_name            TEXT        NOT NULL,
  official_url         TEXT,
  terminal_addresses   JSONB,  -- array of { terminal, address } objects
  parking_info         TEXT,
  transit_dropoff_info TEXT,
  arrival_advice       TEXT,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Authenticated users can read port info for email rendering.
ALTER TABLE public.port_info_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY port_info_read ON public.port_info_chunks
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY port_info_insert_service ON public.port_info_chunks
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY port_info_update_service ON public.port_info_chunks
  FOR UPDATE USING (FALSE);

GRANT SELECT ON public.port_info_chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.port_info_chunks TO service_role;

-- Seed 17 ports with TODO(content) placeholders per §23.4.
INSERT INTO public.port_info_chunks (port_code, port_name, official_url, terminal_addresses, parking_info, transit_dropoff_info, arrival_advice)
VALUES
  ('MIA',  'Miami, FL',          'https://www.miamidade.gov/portmiami/',          NULL, NULL, NULL, NULL),
  ('PCV',  'Port Canaveral, FL', 'https://www.portcanaveral.com/',                NULL, NULL, NULL, NULL),
  ('GAL',  'Galveston, TX',      'https://www.portofgalveston.com/',              NULL, NULL, NULL, NULL),
  ('SEA',  'Seattle, WA',        'https://www.portseattle.org/maritime/',         NULL, NULL, NULL, NULL),
  ('YVR',  'Vancouver, BC',      'https://www.portvancouver.com/',                NULL, NULL, NULL, NULL),
  ('NYC',  'New York, NY',       'https://www.nycruise.com/',                     NULL, NULL, NULL, NULL),
  ('BOS',  'Boston, MA',         'https://www.massport.com/cruiseport-boston/',   NULL, NULL, NULL, NULL),
  ('BAL',  'Baltimore, MD',      'https://mpa.maryland.gov/Pages/cruise.aspx',    NULL, NULL, NULL, NULL),
  ('MSY',  'New Orleans, LA',    'https://portnola.com/',                         NULL, NULL, NULL, NULL),
  ('LAX',  'Los Angeles, CA',    'https://www.portoflosangeles.org/business/cruise/', NULL, NULL, NULL, NULL),
  ('SAN',  'San Diego, CA',      'https://www.portofsandiego.org/cruise',         NULL, NULL, NULL, NULL),
  ('SFO',  'San Francisco, CA',  'https://sfport.com/maritime/cruise',            NULL, NULL, NULL, NULL),
  ('LGB',  'Long Beach, CA',     'https://www.polb.com/cruise',                  NULL, NULL, NULL, NULL),
  ('TPA',  'Tampa, FL',          'https://www.tampaport.com/cruise/',             NULL, NULL, NULL, NULL),
  ('JAX',  'Jacksonville, FL',   'https://www.jaxport.com/cargo/cruise/',         NULL, NULL, NULL, NULL),
  ('MOB',  'Mobile, AL',         'https://www.asdd.com/cruise-terminals/',        NULL, NULL, NULL, NULL),
  ('ORF',  'Norfolk, VA',        'https://www.portofvirginia.com/marine-terminals/nct/', NULL, NULL, NULL, NULL)
ON CONFLICT (port_code) DO NOTHING;

-- ── notifications — §23.8 ─────────────────────────────────────────────────────
CREATE TABLE public.notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES public.tenants(id),
  user_id      UUID        NOT NULL REFERENCES public.users(id),
  category     TEXT        NOT NULL CHECK (category IN (
    'booking_update','commission_settled','group_activity','escalation','system'
  )),
  title        TEXT        NOT NULL,
  body         TEXT,
  link_url     TEXT,
  icon         TEXT,
  read_at      TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX notifications_user_unread_idx
  ON public.notifications(user_id, read_at)
  WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users can read and update (mark-read/dismiss) their own notifications.
CREATE POLICY notifications_own_select ON public.notifications
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY notifications_own_update ON public.notifications
  FOR UPDATE USING (user_id = auth.uid());
-- INSERT and DELETE are service_role only.
CREATE POLICY notifications_insert_service ON public.notifications
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY notifications_delete_service ON public.notifications
  FOR DELETE USING (FALSE);

GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role;
