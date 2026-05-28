-- F1 — Token-gated chat conversation anchoring.
--
-- Adds a stable identifier for the conversation associated with a
-- /api/public/chat/[token] session, so the §10 supervisor can write
-- findings against a real conversations row and persist messages.
--
-- The column stores a SHA-256 hash of the customer access token (hex,
-- 64 chars). We do NOT store the raw token here — that's already in
-- quotes.customer_access_token / trip_itineraries.access_token. Hashing
-- means a leaked conversations dump can't be replayed against the
-- public chat endpoint.
--
-- RLS unchanged: conversations table is auth_user_in_tenant-scoped.
-- The public chat route uses service-role (already on allowlist), so
-- RLS isn't a barrier; the column exists so service-role lookups can
-- be (tenant_id, public_access_token_hash) idempotent.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS public_access_token_hash TEXT;

-- Composite uniqueness: one conversation per (tenant, token hash).
-- Partial index — only enforces when the hash is set (regular chat
-- conversations have it null).
CREATE UNIQUE INDEX IF NOT EXISTS conversations_public_token_uniq
  ON public.conversations (tenant_id, public_access_token_hash)
  WHERE public_access_token_hash IS NOT NULL;

COMMENT ON COLUMN public.conversations.public_access_token_hash IS
  'SHA-256 hex (64 chars) of the customer_access_token / access_token
   that gates the token-only chat surface. Set only for conversations
   anchored to /api/public/chat/[token]. NULL for regular customer
   chat (those use user_id or anonymous_session_id instead).';
