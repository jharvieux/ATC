-- Tier 2.5 — table grants for PostgREST.
--
-- PostgREST authenticates HTTP requests, decodes the JWT, switches to the
-- PG role named in the JWT's `role` claim, then runs the query. The role
-- must have the relevant grants on each table being read or written.
--
-- service_role: full table privileges + BYPASSRLS (matches Supabase Cloud's
-- service_role behaviour — RLS is enforced for app users, bypassed for the
-- service-role admin path).
-- authenticated + anon: SELECT/INSERT/UPDATE/DELETE on tenant-scoped tables;
-- RLS policies still apply to filter rows.
--
-- Idempotent: re-running just re-asserts the same grants.

-- BYPASSRLS for service_role (matches Supabase).
ALTER ROLE service_role WITH BYPASSRLS;

-- Schema usage.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Tables — broad grant; RLS still gates per-row for anon/authenticated,
-- BYPASSRLS lets service_role through.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;

-- Sequences (so INSERTs that use DEFAULT nextval(...) work).
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon, authenticated, service_role;

-- Functions (e.g. match_knowledge_chunks RPC).
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
