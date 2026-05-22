-- §10.5a Supervisor Sampling and Review Queue
--
-- Platform-internal table — not tenant-facing. Every sampled message lands
-- here with a snapshot of findings and conversation context for human review.
--
-- RLS exception (see db/rls-exceptions.txt):
--   SELECT/UPDATE: platform admins only (via service_role + withPlatformAdminAudit)
--   INSERT: service_role only (supervisor sampling path)
--   DELETE: service_role only (retention purge cron)
--
-- Authenticated users have NO direct access to this table.

CREATE TABLE public.supervisor_review_queue (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL REFERENCES public.tenants(id),
  message_id                      UUID        NOT NULL REFERENCES public.messages(id),
  conversation_id                 UUID        NOT NULL REFERENCES public.conversations(id),
  sample_category                 TEXT        NOT NULL CHECK (sample_category IN (
                                    'clean_pass', 'warning_pass', 'regen_attempted', 'escalation'
                                  )),
  supervisor_findings_snapshot    JSONB       NOT NULL,
  conversation_context_snapshot   JSONB,
  review_status                   TEXT        NOT NULL CHECK (review_status IN (
                                    'pending', 'reviewed_ok', 'reviewed_issue', 'disputed_resolved'
                                  )) DEFAULT 'pending',
  reviewed_by_user_id             UUID        REFERENCES public.users(id),
  reviewed_at                     TIMESTAMPTZ,
  review_notes                    TEXT,
  sampled_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after                     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);

-- Partial index per §10.5a — optimises the "pending review" queue query
CREATE INDEX supervisor_review_queue_status_idx
  ON public.supervisor_review_queue(review_status, sampled_at DESC)
  WHERE review_status = 'pending';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Platform-internal table. No authenticated-user policies. All access
-- goes through service_role (withPlatformAdminAudit) which bypasses RLS.

ALTER TABLE public.supervisor_review_queue ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated role — RLS implicitly blocks all access.

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supervisor_review_queue TO service_role;
-- No GRANT to authenticated — intentional.
