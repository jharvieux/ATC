-- §19.1–19.10 — Forum-style group chat tables.
--
-- One forum per group (UNIQUE group_id on forums).
-- Message moderation uses a fail-closed Haiku contract with a distinct
-- pending_moderation status, retry with optimistic locking, and 24-hour escalation.
-- RLS: forum tables are tenant-scoped. Invitees see only visible messages
-- (plus their own pending/flagged submissions). Coordinators and service_role
-- see all statuses.

-- ── forums ───────────────────────────────────────────────────────────────────
CREATE TABLE public.forums (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID        NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  tenant_id    UUID        NOT NULL REFERENCES public.tenants(id),
  is_locked    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id)
);

CREATE INDEX forums_tenant_id_idx ON public.forums(tenant_id);

ALTER TABLE public.forums ENABLE ROW LEVEL SECURITY;

CREATE POLICY forums_select ON public.forums
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY forums_insert ON public.forums
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forums_update ON public.forums
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forums_delete ON public.forums
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.forums TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forums TO service_role;

-- ── forum_threads ─────────────────────────────────────────────────────────────
CREATE TABLE public.forum_threads (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  forum_id             UUID        NOT NULL REFERENCES public.forums(id) ON DELETE CASCADE,
  tenant_id            UUID        NOT NULL REFERENCES public.tenants(id),
  created_by_user_id   UUID        NOT NULL REFERENCES public.users(id),
  title                TEXT        NOT NULL,
  is_locked            BOOLEAN     NOT NULL DEFAULT FALSE,
  is_pinned            BOOLEAN     NOT NULL DEFAULT FALSE,
  is_announcement      BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX forum_threads_forum_id_idx ON public.forum_threads(forum_id);
CREATE INDEX forum_threads_tenant_id_idx ON public.forum_threads(tenant_id);

ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY forum_threads_select ON public.forum_threads
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_threads_insert ON public.forum_threads
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forum_threads_update ON public.forum_threads
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forum_threads_delete ON public.forum_threads
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.forum_threads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_threads TO service_role;

-- ── forum_messages ────────────────────────────────────────────────────────────
-- One-level reply enforced: non-NULL parent_message_id must reference a
-- top-level message (parent_message_id IS NULL on the parent). §19.1.
CREATE TABLE public.forum_messages (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id                 UUID        NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  tenant_id                 UUID        NOT NULL REFERENCES public.tenants(id),
  forum_id                  UUID        NOT NULL REFERENCES public.forums(id),
  user_id                   UUID        NOT NULL REFERENCES public.users(id),
  parent_message_id         UUID        REFERENCES public.forum_messages(id),
  content                   TEXT        NOT NULL,
  content_edited_at         TIMESTAMPTZ,
  edit_history              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  deleted_at                TIMESTAMPTZ,
  -- Moderation status (§19.3)
  status                    TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','visible','flagged_review','hidden','pending_moderation')),
  moderation_scores         JSONB,
  moderation_decision_reason TEXT,
  -- Fail-closed retry state (§19.3)
  pending_moderation_since  TIMESTAMPTZ,
  moderation_attempt_count  INTEGER     NOT NULL DEFAULT 0,
  moderation_last_attempt_at TIMESTAMPTZ,
  moderation_last_error     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- One-level reply invariant is enforced by the trigger below.
  -- (A CHECK constraint cannot contain a subquery in PostgreSQL.)
);

-- §19.1 — One-level reply: a reply's parent must itself be top-level.
-- Enforced as a BEFORE INSERT/UPDATE trigger (CHECK constraints don't
-- allow subqueries in PostgreSQL).
CREATE OR REPLACE FUNCTION public.forum_messages_assert_one_level_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.parent_message_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.forum_messages p
    WHERE p.id = NEW.parent_message_id
      AND p.parent_message_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'forum_messages.one_level_reply: parent message (%) is itself a reply; only one level of nesting is allowed', NEW.parent_message_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.forum_messages_assert_one_level_reply() FROM public;
GRANT  EXECUTE ON FUNCTION public.forum_messages_assert_one_level_reply() TO authenticated, service_role;

CREATE TRIGGER forum_messages_one_level_reply_trg
  BEFORE INSERT OR UPDATE OF parent_message_id ON public.forum_messages
  FOR EACH ROW EXECUTE FUNCTION public.forum_messages_assert_one_level_reply();

CREATE INDEX forum_messages_thread_created_idx ON public.forum_messages(thread_id, created_at);
CREATE INDEX forum_messages_moderation_queue_idx
  ON public.forum_messages(status)
  WHERE status IN ('pending_moderation','flagged_review');
CREATE INDEX forum_messages_forum_id_idx ON public.forum_messages(forum_id);

ALTER TABLE public.forum_messages ENABLE ROW LEVEL SECURITY;

-- Regular invitees see visible messages plus their own (any status).
-- Coordinators and service_role see everything — enforced at the API layer
-- (tenantClient with coordinator check) and via service_role bypass.
CREATE POLICY forum_messages_select ON public.forum_messages
  FOR SELECT USING (
    auth_user_in_tenant(tenant_id)
    AND (
      status = 'visible'
      OR user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
    )
  );
CREATE POLICY forum_messages_insert ON public.forum_messages
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forum_messages_update ON public.forum_messages
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_messages_delete ON public.forum_messages
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.forum_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_messages TO service_role;

-- ── forum_reactions ───────────────────────────────────────────────────────────
CREATE TABLE public.forum_reactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES public.forum_messages(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.users(id),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  emoji       TEXT        NOT NULL CHECK (emoji IN ('thumbs_up','heart','laugh','surprised','celebrate','eyes')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX forum_reactions_message_id_idx ON public.forum_reactions(message_id);

ALTER TABLE public.forum_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY forum_reactions_select ON public.forum_reactions
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_reactions_insert ON public.forum_reactions
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY forum_reactions_update ON public.forum_reactions
  FOR UPDATE USING (FALSE);
CREATE POLICY forum_reactions_delete ON public.forum_reactions
  FOR DELETE USING (
    auth_user_in_tenant(tenant_id)
    AND user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

GRANT SELECT, INSERT, DELETE ON public.forum_reactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_reactions TO service_role;

-- ── forum_user_state ──────────────────────────────────────────────────────────
CREATE TABLE public.forum_user_state (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  forum_id        UUID        NOT NULL REFERENCES public.forums(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES public.users(id),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id),
  is_muted        BOOLEAN     NOT NULL DEFAULT FALSE,
  muted_until     TIMESTAMPTZ,
  muted_by_user_id UUID       REFERENCES public.users(id),
  mute_reason     TEXT,
  strike_count    INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (forum_id, user_id)
);

CREATE INDEX forum_user_state_forum_id_idx ON public.forum_user_state(forum_id);

ALTER TABLE public.forum_user_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY forum_user_state_select ON public.forum_user_state
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_user_state_insert ON public.forum_user_state
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_user_state_update ON public.forum_user_state
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_user_state_delete ON public.forum_user_state
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.forum_user_state TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_user_state TO service_role;

-- ── forum_strikes ─────────────────────────────────────────────────────────────
CREATE TABLE public.forum_strikes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  forum_id    UUID        NOT NULL REFERENCES public.forums(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.users(id),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  message_id  UUID        REFERENCES public.forum_messages(id),
  strike_kind TEXT        NOT NULL CHECK (strike_kind IN ('ai_hidden','coordinator_hidden')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX forum_strikes_user_created_idx ON public.forum_strikes(user_id, created_at);

ALTER TABLE public.forum_strikes ENABLE ROW LEVEL SECURITY;

CREATE POLICY forum_strikes_select ON public.forum_strikes
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_strikes_insert ON public.forum_strikes
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY forum_strikes_update ON public.forum_strikes
  FOR UPDATE USING (FALSE);
CREATE POLICY forum_strikes_delete ON public.forum_strikes
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT ON public.forum_strikes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_strikes TO service_role;
