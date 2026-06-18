-- #821 — Enable RLS on the remaining RAG public tables (defense-in-depth).
--
-- The Supabase advisor flagged these 8 tables as RLS-disabled. Safe to enable:
--   * The RAG app connects exclusively as service_role
--     (SUPABASE_RAG_SERVICE_ROLE_KEY), which has BYPASSRLS — RLS does not apply
--     to it — AND, since 0025, table-level GRANTs on the whole public schema, so
--     it can still read/write every table. Enabling RLS does not affect the app.
--   * anon / authenticated have NO grants on these tables, so they are already
--     blocked at the grant layer; RLS makes that explicit and future-proof — if
--     a grant is ever added by accident, deny-all RLS (no policies) still blocks
--     non-bypass roles.
--
-- No policies = service-role only (the established pattern; see 0023/0024).
-- Regenerate db/rls-snapshot-rag.sql after applying.

-- #1078 follow-up: public.schema_migrations is the retired db-migrate ledger,
-- dropped in 0030. Never created on fresh DBs (migration files don't create it),
-- so guard with IF EXISTS to avoid erroring on fresh builds.
alter table if exists public.schema_migrations enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_ingestion_queue enable row level security;
alter table public.rag_retrieval_log enable row level security;
alter table public.knowledge_chunk_feedback_events enable row level security;
alter table public.platform_settings enable row level security;
alter table public.tenant_registry_shadow enable row level security;
alter table public.itineraries enable row level security;
