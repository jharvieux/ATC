-- 0025 — Grant service_role the standard privileges on the public schema.
--
-- Root cause (found while debugging the embedding worker's 403s): the RAG
-- tables enable RLS with deny-all (zero policies) on the assumption that "only
-- the service-role connection bypasses RLS" (see e.g. 0023). That assumption is
-- necessary but NOT sufficient. `service_role` has BYPASSRLS, which lets it skip
-- row policies — but a role still needs table-level GRANTs to touch a table at
-- all. These grants were never set up on the RAG project (the main app has them;
-- the RAG app's migrations never granted service_role).
--
-- The result: every PostgREST request authenticated as service_role got
-- `403 permission denied` — breaking the embedding worker (pending_embedding),
-- RAG retrieval (knowledge_chunks), and the inter-service JWT verifier's
-- tenant_registry_shadow lookup (which 500s the cruisemapper ingest the moment
-- it gets past the Redis replay check).
--
-- This restores the standard Supabase service_role grants and sets default
-- privileges so future migration-created tables inherit them and this can't
-- silently recur. anon/authenticated stay RLS-denied as designed.

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
