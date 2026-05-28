-- §7.9 — Idempotency-Key HTTP header support.
--
-- Pre-fix: the spec promised "critical mutations accept Idempotency-Key
-- header (24-hour cache)" but no public route honored it. CAS guards exist
-- for SOME mutations (quotes accept, payouts CAS lock, invite first-use)
-- but those are different shapes — they prevent duplicate-by-state, not
-- duplicate-by-retry.
--
-- Stripe-style idempotency contract: a client that sends the same
-- Idempotency-Key for the same endpoint gets the cached response back
-- regardless of whether the original request actually completed. This
-- defends against client retries after a network blip — the second call
-- must NOT double-mutate.
--
-- Scope: store the response so the SAME response shape (status + body)
-- can be replayed. 24h TTL aligns with §7.9 spec.

CREATE TABLE public.request_idempotency (
  -- Composite primary key: the same idempotency key across different
  -- routes is allowed (different mutations may share an X-Request-Id-
  -- style key without colliding).
  idempotency_key TEXT NOT NULL,
  route TEXT NOT NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- The cached response. Stored as TEXT (response bodies are JSON
  -- strings in our routes; BLOB-ifying as bytea adds zero value).
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  -- Optional: store a content-type so we can replay arbitrary types
  -- (most are application/json; some may be text/plain or empty).
  response_content_type TEXT,
  -- The user/auth context the original call ran under. Replay only
  -- returns the cached response if the SAME auth_user_id is calling
  -- again — prevents an attacker who learns a key from replaying
  -- under a different identity.
  auth_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  PRIMARY KEY (idempotency_key, route)
);

CREATE INDEX request_idempotency_expires_idx
  ON public.request_idempotency(expires_at);

CREATE INDEX request_idempotency_tenant_idx
  ON public.request_idempotency(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- RLS: only the service-role + the originating user should read.
-- The middleware reads via service-role (handler bypass); tenant users
-- never query this table directly. Lock down.
ALTER TABLE public.request_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY request_idempotency_no_user_select ON public.request_idempotency
  FOR SELECT USING (FALSE);

CREATE POLICY request_idempotency_no_user_insert ON public.request_idempotency
  FOR INSERT WITH CHECK (FALSE);

CREATE POLICY request_idempotency_no_user_update ON public.request_idempotency
  FOR UPDATE USING (FALSE);

CREATE POLICY request_idempotency_no_user_delete ON public.request_idempotency
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_idempotency TO service_role;
