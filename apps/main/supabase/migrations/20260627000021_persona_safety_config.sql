-- §9.3 / §9.7 — persona_safety_config (singleton; platform-admin editable).
--
-- Holds ONLY the admin-editable safety block (booking commitments, escalation
-- triggers, customer privacy). The LEGAL_KERNEL (AI-disclosure + no licensed-
-- professional advice) stays code-side in platform-constraints.ts and is shown
-- READ-ONLY in the admin UI — it is a legal/compliance obligation, not a tuning
-- knob (D-138). At prompt-build time the full Layer-2 block is reassembled as
-- LEGAL_KERNEL + this editable block.
--
-- Singleton: a single 'default' row. PK + CHECK make a second row impossible.
-- Seed source of truth: SAFETY_EDITABLE_DEFAULT (platform-constraints.ts),
-- reproduced verbatim below (byte-identical) so the DB baseline matches the
-- hot-path fallback / restore-to-default target.
--
-- RLS mirrors personas: authenticated SELECT, authenticated writes denied,
-- service_role writes behind assertPlatformAdmin.

CREATE TABLE public.persona_safety_config (
  id             TEXT        PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  editable_block TEXT        NOT NULL,
  version        INTEGER     NOT NULL DEFAULT 1,
  updated_by     UUID,        -- auth_user_id of last platform-admin editor (NULL = seeded)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.persona_safety_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY persona_safety_config_select_policy ON public.persona_safety_config
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY persona_safety_config_insert_deny ON public.persona_safety_config
  FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY persona_safety_config_update_deny ON public.persona_safety_config
  FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY persona_safety_config_delete_deny ON public.persona_safety_config
  FOR DELETE TO authenticated
  USING (false);

GRANT SELECT ON public.persona_safety_config TO authenticated;
GRANT SELECT, UPDATE ON public.persona_safety_config TO service_role;

CREATE TRIGGER persona_safety_config_updated_at
  BEFORE UPDATE ON public.persona_safety_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.persona_safety_config (editable_block) VALUES (
  $seed$### Booking commitments
- You may collect booking details and provide quotes, but you MUST NOT confirm a booking as final without going through the host agency's explicit confirmation flow.
- Always clarify that quotes are subject to availability and final pricing at the time of booking.

### Escalation triggers (§10)
- Immediately escalate to a human supervisor if the customer:
  - Expresses distress, safety concerns, or a medical emergency
  - Makes repeated complaints after your attempts to resolve
  - Requests to speak to a human explicitly
  - Provides information suggesting fraudulent activity
  - Is in a jurisdiction with specific regulatory requirements you cannot satisfy

### Customer privacy
- Never share one customer's personal information with another
- Never reveal internal pricing strategies, commission structures, or host agency confidential data$seed$
);
