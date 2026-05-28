-- §9.6 — Audit table for persona tool dispatches.
--
-- One row per dispatched tool_use block (escalate_to_human,
-- get_customer_context, update_memory, etc.). Pre-fix, the only
-- record of which tools fired was console.info from the dispatcher —
-- queryable history was impossible. This table powers:
--
--   - per-tenant analytics ("how many escalations this week")
--   - per-conversation forensic replay (what tools did the AI run
--     in this thread)
--   - per-tool error rates (when a handler is broken, ops sees it)
--
-- WRITE PATH: the dispatcher (apps/main/src/lib/personas/tools/dispatch.ts)
-- inserts via service-role client.
--
-- READ PATH: tenant-scoped SELECT via RLS — the in-app admin UI can
-- show its own tool history.

CREATE TABLE public.ai_tool_calls (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  conversation_id UUID         NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  -- The tool name from PERSONA_TOOLS registry. NOT a FK because the
  -- registry lives in code, not the DB. Stored verbatim so we can audit
  -- even tools that were later removed/renamed.
  tool_name       TEXT         NOT NULL,
  -- Anthropic's tool_use.id from the LLM response. Lets us correlate
  -- with the original message content if needed.
  tool_use_id     TEXT,
  -- What the LLM passed as the tool input (after Anthropic schema validation).
  input_json      JSONB        NOT NULL,
  -- The tool_result content the dispatcher returned to the LLM. Parsed
  -- JSON when the handler returned JSON; raw string otherwise. NULL on
  -- handler error (see error_text).
  result_json     JSONB,
  -- True when the handler reported mutating DB state (used for
  -- "show me all memory writes" / "show me escalations triggered" reports).
  was_mutating    BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Populated when the handler threw and the dispatcher caught it; the
  -- tool_result returned to the LLM has the same detail.
  error_text      TEXT,
  -- Wall-clock duration of the handler call (handler-only, not LLM round-trip).
  duration_ms     INTEGER      NOT NULL,
  dispatched_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-tenant time-ordered scan (admin "recent tool activity" UI).
CREATE INDEX ai_tool_calls_tenant_dispatched_idx
  ON public.ai_tool_calls(tenant_id, dispatched_at DESC);

-- Per-conversation thread replay.
CREATE INDEX ai_tool_calls_conversation_idx
  ON public.ai_tool_calls(conversation_id, dispatched_at DESC);

-- Per-tool aggregation ("escalation rate over last 30d").
CREATE INDEX ai_tool_calls_tool_name_dispatched_idx
  ON public.ai_tool_calls(tool_name, dispatched_at DESC);

ALTER TABLE public.ai_tool_calls ENABLE ROW LEVEL SECURITY;

-- Tenant users can SELECT their tenant's rows (admin UI for "show me
-- what tools the AI ran this week"). NOT updateable/deleteable from
-- the tenant side — audit is append-only.
CREATE POLICY ai_tool_calls_select_policy ON public.ai_tool_calls
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

-- Write paths are service-role only (the dispatcher inserts after
-- each handler call). No INSERT/UPDATE/DELETE policy → service-role
-- bypasses RLS for those operations.
GRANT SELECT, INSERT ON public.ai_tool_calls TO service_role;
