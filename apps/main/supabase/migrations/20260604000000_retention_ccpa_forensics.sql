-- §25 — Retention closeout, free-text anonymization, forensics capture.
--
-- Closes the Part 4 Prompt 17 stub: purgeUserDataPerRetention runs the
-- §25.4a three-category anonymization. Forensics-snapshot-before-deletion
-- captures into a new forensics_log table (decrypt path + retention cron
-- land in BP26 per §26.5a).
--
-- Schema deltas vs. the build prompt's verbatim wording (resolved while
-- writing this — full rationale in MEMORY D-058):
--   • `bookings.customer_user_id` is actually `bookings.user_id` (BP15).
--   • `bookings.dispute_state` does not exist; only commissions has dispute
--     fields. Forensics-snapshot trigger checks commissions.dispute_status.
--   • Bookings has no denormalized customer PII columns; passenger PII
--     lives on booking_passengers. The Category-3 substitute is to
--     anonymize the deleting user's passenger contact_id FKs.
--   • `quotes.narrative` does not yet exist — added by this migration so
--     the Category-2 path has its third spec-named target.
--   • `tenant_crm_notes` does not exist and `contacts` has no `notes`
--     column. Both are added here (contacts.notes + contacts.
--     anonymized_customer_hash) so the Category-3 contract has somewhere
--     to land — see MEMORY D-058.
--   • audit_log table still does not exist (D-036). All audit writes
--     remain console.warn stubs; forensics_log.audit_log_id is a bare
--     UUID with TODO(audit-log-fk).

-- ──────────────────────────────────────────────────────────────────────────
-- 1. ccpa_deletion_executions — one row per executed purge.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.ccpa_deletion_executions (
  id                                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                               UUID        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  tenant_id                             UUID        REFERENCES public.tenants(id),
  grace_period_ended_at                 TIMESTAMPTZ NOT NULL,
  executed_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Category counts (§25.4a)
  category_1_messages_nulled_count      INTEGER     NOT NULL DEFAULT 0,
  category_2_narratives_nulled_count    INTEGER     NOT NULL DEFAULT 0,
  category_2_memories_deleted_count     INTEGER     NOT NULL DEFAULT 0,
  category_3_notes_anonymized_count     INTEGER     NOT NULL DEFAULT 0,

  -- §25.4 booking + commission anonymization
  bookings_anonymized_count             INTEGER     NOT NULL DEFAULT 0,
  commissions_anonymized_count          INTEGER     NOT NULL DEFAULT 0,
  passenger_contacts_anonymized_count   INTEGER     NOT NULL DEFAULT 0,

  -- Forensics snapshot taken before deletion (only when active disputes)
  -- TODO(audit-log-fk): convert to FK when audit_log lands (D-036).
  forensics_snapshot_id                 UUID,
  forensics_snapshot_reason             TEXT,

  customer_hash                         TEXT        NOT NULL,
  purge_outcome                         TEXT        NOT NULL DEFAULT 'success'
                                          CHECK (purge_outcome IN ('success','partial_failure','error')),
  error_detail                          TEXT,

  UNIQUE (user_id)
);

CREATE INDEX ccpa_deletion_executions_outcome_idx
  ON public.ccpa_deletion_executions(purge_outcome, executed_at);

ALTER TABLE public.ccpa_deletion_executions ENABLE ROW LEVEL SECURITY;

-- Service-role-only writes; tenant-scoped read for admin dashboards.
CREATE POLICY ccpa_executions_select ON public.ccpa_deletion_executions
  FOR SELECT USING (tenant_id IS NOT NULL AND auth_user_in_tenant(tenant_id));
CREATE POLICY ccpa_executions_insert_service ON public.ccpa_deletion_executions
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY ccpa_executions_update_service ON public.ccpa_deletion_executions
  FOR UPDATE USING (FALSE);
CREATE POLICY ccpa_executions_delete_service ON public.ccpa_deletion_executions
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.ccpa_deletion_executions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ccpa_deletion_executions TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. forensics_log — §26.5a snapshot-before-deletion table.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.forensics_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        REFERENCES public.tenants(id),
  -- TODO(audit-log-fk): convert to FK when audit_log lands (D-036).
  audit_log_id          UUID,
  snapshot_type         TEXT        NOT NULL CHECK (snapshot_type IN (
                          'commission_dispute','booking_dispute','tenant_complaint',
                          'ai_misbehavior_investigation','data_export_request','security_incident'
                        )),
  reason                TEXT        NOT NULL,
  encrypted_payload     BYTEA       NOT NULL,
  encryption_key_id     TEXT        NOT NULL,
  redacted_summary      JSONB,
  captured_by_user_id   UUID        REFERENCES public.users(id),
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after           TIMESTAMPTZ NOT NULL,
  legal_hold            BOOLEAN     NOT NULL DEFAULT FALSE,
  last_accessed_at      TIMESTAMPTZ,
  access_count          INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX forensics_log_purge_idx
  ON public.forensics_log(purge_after)
  WHERE legal_hold = FALSE;

CREATE INDEX forensics_log_audit_link_idx
  ON public.forensics_log(audit_log_id)
  WHERE audit_log_id IS NOT NULL;

ALTER TABLE public.forensics_log ENABLE ROW LEVEL SECURITY;

-- No tenant-level access. Service-role-only writes; reads only via the
-- BP26 admin path (decryptForensicsSnapshot + withPlatformAdminAudit).
CREATE POLICY forensics_log_select_service ON public.forensics_log
  FOR SELECT USING (FALSE);
CREATE POLICY forensics_log_insert_service ON public.forensics_log
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY forensics_log_update_service ON public.forensics_log
  FOR UPDATE USING (FALSE);
CREATE POLICY forensics_log_delete_service ON public.forensics_log
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.forensics_log TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. bookings + commissions anonymization columns (§25.4).
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS anonymized_customer_hash TEXT,
  ADD COLUMN IF NOT EXISTS anonymized_at            TIMESTAMPTZ;

ALTER TABLE public.commissions
  ADD COLUMN IF NOT EXISTS anonymized_customer_hash TEXT,
  ADD COLUMN IF NOT EXISTS anonymized_at            TIMESTAMPTZ;

COMMENT ON COLUMN public.bookings.anonymized_customer_hash IS
  '§25.4: set on CCPA purge; user_id is nulled and the hash preserves cross-table linkage.';
COMMENT ON COLUMN public.commissions.anonymized_customer_hash IS
  '§25.4: set on CCPA purge alongside bookings.';

-- ──────────────────────────────────────────────────────────────────────────
-- 4. quotes.narrative TEXT — Category 2 spec-named target.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS narrative TEXT;

COMMENT ON COLUMN public.quotes.narrative IS
  '§25.4a Category 2: AI-generated quote narrative. NULLed on customer CCPA purge.';

-- ──────────────────────────────────────────────────────────────────────────
-- 5. contacts.notes + contacts.anonymized_customer_hash — Category 3 surface.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS notes                    TEXT,
  ADD COLUMN IF NOT EXISTS anonymized_customer_hash TEXT;

COMMENT ON COLUMN public.contacts.notes IS
  '§25.4a Category 3: tenant-authored CRM notes about this contact. Retained on customer CCPA purge with FK anonymization.';
COMMENT ON COLUMN public.contacts.anonymized_customer_hash IS
  '§25.4a Category 3: hash-derived placeholder when contacts.user_id is nulled on customer purge.';

-- ──────────────────────────────────────────────────────────────────────────
-- 6. users — purge marker, phone, cookie/consent columns.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone                          TEXT,
  ADD COLUMN IF NOT EXISTS deleted_purged_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cookie_preferences             JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS performance_analytics_opt_out  BOOLEAN NOT NULL DEFAULT FALSE;

-- Extend users.status CHECK to include 'purged'.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','suspended','deleted','purged'));

-- Partial index for the retention purge cron (find users due for purge).
CREATE INDEX IF NOT EXISTS users_status_deleted_idx
  ON public.users(deleted_at)
  WHERE status = 'deleted';

COMMENT ON COLUMN public.users.deleted_purged_at IS
  '§25.3 / §25.4a: timestamp the 30-day grace expired and purge ran.';
COMMENT ON COLUMN public.users.cookie_preferences IS
  '§25.8: { performance: bool, marketing: bool } persisted for authenticated users (anonymous users get the first-party cookie only).';
COMMENT ON COLUMN public.users.performance_analytics_opt_out IS
  '§25.7: explicit opt-out for analytics; mirrors cookie_preferences.performance but persists across cookie clears.';

-- ──────────────────────────────────────────────────────────────────────────
-- 7. staging_cron_skips — §25.10 visibility for skipped runs in staging.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.staging_cron_skips (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_id      TEXT        NOT NULL,
  skipped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason       TEXT        NOT NULL DEFAULT 'STAGING_MODE'
);

CREATE INDEX staging_cron_skips_cron_id_idx
  ON public.staging_cron_skips(cron_id, skipped_at DESC);

ALTER TABLE public.staging_cron_skips ENABLE ROW LEVEL SECURITY;

CREATE POLICY staging_cron_skips_select_service ON public.staging_cron_skips
  FOR SELECT USING (FALSE);
CREATE POLICY staging_cron_skips_insert_service ON public.staging_cron_skips
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY staging_cron_skips_update_service ON public.staging_cron_skips
  FOR UPDATE USING (FALSE);
CREATE POLICY staging_cron_skips_delete_service ON public.staging_cron_skips
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staging_cron_skips TO service_role;
