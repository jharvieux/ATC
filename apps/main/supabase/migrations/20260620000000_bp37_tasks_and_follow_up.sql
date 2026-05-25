-- BP37 §37 — Tasks & Follow-up
--
-- Three table families:
--   1. tasks + task_reminders     — per-record actionable items
--   2. task_sequences + steps     — predefined cadence templates
--   3. task_sequence_runs (+ snapshot) — per-trigger instantiation
--
-- task_sequence_runs is created before tasks so the FK from tasks.sequence_run_id
-- can satisfy.

-- ── 37.4.1 task_sequences + steps + runs ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN (
    'lead_created','quote_sent','quote_accepted','booking_created',
    'booking_confirmed','pre_sail_60d','post_sail_7d','manual'
  )),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  applies_to_record TEXT NOT NULL DEFAULT 'auto'
    CHECK (applies_to_record IN ('auto','contact','quote','booking')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_sequences_tenant_trigger_idx
  ON public.task_sequences(tenant_id, trigger_event)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS public.task_sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES public.task_sequences(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  offset_days INT NOT NULL,
  offset_hours INT NOT NULL DEFAULT 0,
  task_title_template TEXT NOT NULL,
  task_description_template TEXT,
  task_type TEXT NOT NULL,
  task_priority TEXT NOT NULL DEFAULT 'normal',
  reminder_offsets_minutes INT[] DEFAULT ARRAY[]::INT[],
  skip_if_status TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sequence_id, step_index)
);

CREATE TABLE IF NOT EXISTS public.task_sequence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES public.task_sequences(id),
  contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  quote_id   UUID REFERENCES public.quotes(id)   ON DELETE CASCADE,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_by_user_id UUID REFERENCES public.users(id),
  completed_at TIMESTAMPTZ,
  -- §37.8.1 — snapshot of the sequence step definitions at trigger time.
  -- Sequence edits never affect in-flight runs; the engine reads from
  -- this snapshot, not the live task_sequence_steps rows.
  steps_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (contact_id IS NOT NULL)::int +
    (quote_id IS NOT NULL)::int +
    (booking_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS task_sequence_runs_active_idx
  ON public.task_sequence_runs(tenant_id, sequence_id, status)
  WHERE status = 'active';

-- ── 37.2 tasks ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES public.contacts(id)      ON DELETE CASCADE,
  quote_id        UUID REFERENCES public.quotes(id)        ON DELETE CASCADE,
  booking_id      UUID REFERENCES public.bookings(id)      ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'call','email','text','meeting','follow_up','review','document','custom'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','completed','snoozed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),

  due_at TIMESTAMPTZ,
  due_is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
  snoozed_until TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,

  assigned_to_user_id UUID REFERENCES public.users(id),
  created_by_user_id  UUID REFERENCES public.users(id),

  origin TEXT NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual','sequence','system','ai_suggested')),
  origin_reference TEXT,

  sequence_run_id UUID REFERENCES public.task_sequence_runs(id) ON DELETE SET NULL,
  sequence_step_index INT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (
    (contact_id IS NOT NULL)::int +
    (quote_id IS NOT NULL)::int +
    (booking_id IS NOT NULL)::int +
    (conversation_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS tasks_tenant_status_due_idx
  ON public.tasks(tenant_id, status, due_at)
  WHERE status IN ('open','in_progress','snoozed');

CREATE INDEX IF NOT EXISTS tasks_tenant_contact_idx
  ON public.tasks(tenant_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_assigned_idx
  ON public.tasks(tenant_id, assigned_to_user_id, status)
  WHERE assigned_to_user_id IS NOT NULL AND status IN ('open','in_progress');

-- §37.11 — dedupe guard for system-generated tasks.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_system_dedupe_idx
  ON public.tasks(tenant_id, origin, origin_reference)
  WHERE origin = 'system' AND origin_reference IS NOT NULL;

-- ── 37.3 task_reminders ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  task_id   UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  remind_at TIMESTAMPTZ NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email')),
  fired_at TIMESTAMPTZ,
  fired_status TEXT CHECK (fired_status IN ('delivered','suppressed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_reminders_pending_idx
  ON public.task_reminders(remind_at)
  WHERE fired_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
-- Static policy declarations (one block per table) so the migration lint
-- can statically verify §5.1.2 coverage. The shape is identical across all
-- five task tables — auth_user_in_tenant + tenant_is_active per §5.1.

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;

ALTER TABLE public.task_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_reminders_select ON public.task_reminders FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_reminders_insert ON public.task_reminders FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_reminders_update ON public.task_reminders FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_reminders_delete ON public.task_reminders FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_reminders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_reminders TO service_role;

ALTER TABLE public.task_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_sequences_select ON public.task_sequences FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequences_insert ON public.task_sequences FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequences_update ON public.task_sequences FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequences_delete ON public.task_sequences FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequences TO service_role;

ALTER TABLE public.task_sequence_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_sequence_steps_select ON public.task_sequence_steps FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_steps_insert ON public.task_sequence_steps FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_steps_update ON public.task_sequence_steps FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_steps_delete ON public.task_sequence_steps FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequence_steps TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequence_steps TO service_role;

ALTER TABLE public.task_sequence_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_sequence_runs_select ON public.task_sequence_runs FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_runs_insert ON public.task_sequence_runs FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_runs_update ON public.task_sequence_runs FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY task_sequence_runs_delete ON public.task_sequence_runs FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequence_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_sequence_runs TO service_role;

-- ── 37.4.5 default sequence seeder ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.seed_default_task_sequences_for_tenant(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  seq_id UUID;
BEGIN
  -- New lead nurture (lead_created)
  IF NOT EXISTS (SELECT 1 FROM public.task_sequences WHERE tenant_id = p_tenant_id AND name = 'New lead nurture') THEN
    INSERT INTO public.task_sequences (tenant_id, name, description, trigger_event, applies_to_record)
    VALUES (p_tenant_id, 'New lead nurture', 'Three-step outreach after a new lead is created.', 'lead_created', 'contact')
    RETURNING id INTO seq_id;
    INSERT INTO public.task_sequence_steps (tenant_id, sequence_id, step_index, offset_days, task_title_template, task_type, task_priority) VALUES
      (p_tenant_id, seq_id, 1, 1, 'Initial outreach call to {{contact.first_name}}', 'call', 'high'),
      (p_tenant_id, seq_id, 2, 3, 'Follow up if no response from {{contact.first_name}}', 'follow_up', 'normal'),
      (p_tenant_id, seq_id, 3, 7, 'Final follow-up before marking {{contact.first_name}} cold', 'follow_up', 'normal');
  END IF;

  -- Post-quote nurture (quote_sent)
  IF NOT EXISTS (SELECT 1 FROM public.task_sequences WHERE tenant_id = p_tenant_id AND name = 'Post-quote nurture') THEN
    INSERT INTO public.task_sequences (tenant_id, name, description, trigger_event, applies_to_record)
    VALUES (p_tenant_id, 'Post-quote nurture', 'Sequence triggered when a quote is sent to a customer.', 'quote_sent', 'quote')
    RETURNING id INTO seq_id;
    INSERT INTO public.task_sequence_steps (tenant_id, sequence_id, step_index, offset_days, task_title_template, task_type, task_priority, skip_if_status) VALUES
      (p_tenant_id, seq_id, 1, 2, 'Confirm quote receipt with {{contact.first_name}}', 'call', 'normal', ARRAY['accepted','rejected']),
      (p_tenant_id, seq_id, 2, 5, 'Follow up on questions about {{quote.cruise_line}} quote', 'follow_up', 'normal', ARRAY['accepted','rejected']),
      (p_tenant_id, seq_id, 3, 9, 'Quote expires soon — final push to {{contact.first_name}}', 'follow_up', 'high', ARRAY['accepted','rejected']);
  END IF;

  -- Booking confirmation follow-through (booking_confirmed)
  IF NOT EXISTS (SELECT 1 FROM public.task_sequences WHERE tenant_id = p_tenant_id AND name = 'Booking confirmation follow-through') THEN
    INSERT INTO public.task_sequences (tenant_id, name, description, trigger_event, applies_to_record)
    VALUES (p_tenant_id, 'Booking confirmation follow-through', 'Welcome packet + excursion check + docs reminder.', 'booking_confirmed', 'booking')
    RETURNING id INTO seq_id;
    INSERT INTO public.task_sequence_steps (tenant_id, sequence_id, step_index, offset_days, task_title_template, task_type, task_priority) VALUES
      (p_tenant_id, seq_id, 1,  1,  'Send welcome packet to {{contact.first_name}} for {{booking.cruise_line}}', 'email',     'normal'),
      (p_tenant_id, seq_id, 2,  30, 'Check excursion preferences with {{contact.first_name}}', 'follow_up', 'normal'),
      (p_tenant_id, seq_id, 3,  -60, 'Confirm passport and travel docs with {{contact.first_name}}', 'document', 'high');
  END IF;

  -- Post-cruise review request (post_sail_7d)
  IF NOT EXISTS (SELECT 1 FROM public.task_sequences WHERE tenant_id = p_tenant_id AND name = 'Post-cruise review request') THEN
    INSERT INTO public.task_sequences (tenant_id, name, description, trigger_event, applies_to_record)
    VALUES (p_tenant_id, 'Post-cruise review request', 'Trip check-in plus a review/referrals ask.', 'post_sail_7d', 'booking')
    RETURNING id INTO seq_id;
    INSERT INTO public.task_sequence_steps (tenant_id, sequence_id, step_index, offset_days, task_title_template, task_type, task_priority) VALUES
      (p_tenant_id, seq_id, 1, 0, 'Ask {{contact.first_name}} about the {{booking.cruise_line}} trip', 'call', 'normal'),
      (p_tenant_id, seq_id, 2, 7, 'Request review and referrals from {{contact.first_name}}', 'email', 'normal');
  END IF;
END;
$$;

-- Backfill for existing tenants.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM public.seed_default_task_sequences_for_tenant(t.id);
  END LOOP;
END;
$$;
