-- #712 — Personal API tokens for long-lived automation access.
--
-- Tenant owners mint named tokens that act as a specific tenant member.
-- Token value shown once; only the SHA-256 hash is persisted.
-- RLS: deny-all + service-role grant. All reads/writes via API routes
-- gated by assertPermission (resource "api_tokens").

CREATE TABLE public.personal_access_tokens (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_by_user_id  uuid        NOT NULL REFERENCES public.users(id),
  name                text        NOT NULL,
  token_hash          text        NOT NULL UNIQUE,
  scopes              text[]      NOT NULL DEFAULT ARRAY['rag_submissions:create'],
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz
);

CREATE INDEX personal_access_tokens_tenant_idx ON public.personal_access_tokens (tenant_id);
CREATE INDEX personal_access_tokens_user_idx   ON public.personal_access_tokens (user_id);

ALTER TABLE public.personal_access_tokens ENABLE ROW LEVEL SECURITY;

-- Deny-all — no authenticated/anon policies. Service-role bypasses RLS.
-- See db/rls-exceptions.{sql,txt}.

GRANT SELECT, INSERT, UPDATE ON public.personal_access_tokens TO service_role;
