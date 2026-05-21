-- §6.1 / §6.2: pgvector extension + tenant_registry
--
-- The RAG service runs in a separate Supabase project from the main app.
-- tenant_registry is a lightweight read-only mirror of the main app's tenants
-- table, synced via tenant lifecycle webhooks. The RAG service only needs to
-- know that a tenant exists and what type it is.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.tenant_registry (
  tenant_id   UUID        PRIMARY KEY,
  tenant_type TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
