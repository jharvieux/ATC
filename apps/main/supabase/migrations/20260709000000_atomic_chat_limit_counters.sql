-- F-sm-01 / F-sm-02 (#1376 / #1377) — atomic chat-limit increment RPCs.
--
-- Both the authenticated-customer limiter (lib/chat/customer-limit.ts) and the
-- anonymous limiter (lib/chat/anonymous-limit.ts) did a SELECT-then-write
-- read-modify-write to bump their counters. Under concurrency that races: K
-- parallel requests at cap-1 all read the stale count, all pass the gate, and
-- all reach the paid Anthropic call — bypassing the customer hard ceiling
-- (F-sm-01) and the anonymous free-tier signup wall (F-sm-02).
--
-- Fix: a DB-atomic INSERT … ON CONFLICT DO UPDATE … RETURNING that consumes
-- (increments) and returns the post-increment count in one statement. The
-- caller then decides the tier against the returned value (consume-then-check),
-- so exactly one concurrent request crosses each boundary. Mirrors the
-- increment_tenant_ai_cost pattern (20260627000000).
--
-- Both RPCs fold the rolling-window reset into the same statement: when the
-- last activity predates the window, the counter restarts at 1 instead of
-- incrementing a stale value. This replaces the racy TS-side recount/seed.
--
-- Security: SECURITY DEFINER with an empty search_path (every object is
-- schema-qualified) so the service-role caller writes under RLS; EXECUTE is
-- revoked from PUBLIC and granted only to service_role. Callers
-- (lib/chat/*-limit.ts) are on the no-direct-service-role-import allowlist.

-- ── F-sm-01: authenticated customer per-(user, tenant) rolling counter ──────
CREATE OR REPLACE FUNCTION public.increment_customer_chat_count(
  p_user_id     UUID,
  p_tenant_id   UUID,
  p_window_days INTEGER
)
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.customer_chat_counters (user_id, tenant_id, current_count, last_message_at)
  VALUES (p_user_id, p_tenant_id, 1, NOW())
  ON CONFLICT (user_id, tenant_id) DO UPDATE
    SET current_count = CASE
          WHEN public.customer_chat_counters.last_message_at IS NOT NULL
           AND public.customer_chat_counters.last_message_at
               < NOW() - make_interval(days => p_window_days)
          THEN 1
          ELSE public.customer_chat_counters.current_count + 1
        END,
        last_message_at = NOW()
  RETURNING current_count;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_customer_chat_count(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_customer_chat_count(UUID, UUID, INTEGER) TO service_role;

COMMENT ON FUNCTION public.increment_customer_chat_count(UUID, UUID, INTEGER) IS
  'F-sm-01 (#1376): atomic consume-then-check increment of customer_chat_counters.current_count with rolling-window reset. Returns the post-increment count.';

-- ── F-sm-02: anonymous per-identifier counter (session = lifetime; ip/fp = window) ──
CREATE OR REPLACE FUNCTION public.increment_anon_chat_counter(
  p_tenant_id        UUID,
  p_identifier_type  TEXT,
  p_identifier_value TEXT,
  p_window_seconds   INTEGER   -- NULL = lifetime (session); else rolling window
)
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.anonymous_chat_counters
    (identifier_type, identifier_value, tenant_id, current_count, first_message_at, last_message_at)
  VALUES (p_identifier_type, p_identifier_value, p_tenant_id, 1, NOW(), NOW())
  ON CONFLICT (identifier_type, identifier_value, tenant_id) DO UPDATE
    SET current_count = CASE
          WHEN p_window_seconds IS NOT NULL
           AND public.anonymous_chat_counters.last_message_at
               < NOW() - make_interval(secs => p_window_seconds)
          THEN 1
          ELSE public.anonymous_chat_counters.current_count + 1
        END,
        last_message_at = NOW()
  RETURNING current_count;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_anon_chat_counter(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_anon_chat_counter(UUID, TEXT, TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.increment_anon_chat_counter(UUID, TEXT, TEXT, INTEGER) IS
  'F-sm-02 (#1377): atomic consume-then-check increment of anonymous_chat_counters.current_count; rolling-window reset when p_window_seconds is set (ip/fingerprint), lifetime when NULL (session). Returns the post-increment count.';
