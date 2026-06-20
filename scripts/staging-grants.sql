-- =============================================================================
-- staging-grants.sql
-- =============================================================================
-- Run by: .github/workflows/deploy.yml, db-copy job, step "Re-grant public schema"
-- When:   After the public schema is reset (DROP SCHEMA public CASCADE) and the
--         prod public schema is restored into it.
-- Why:    DROP SCHEMA removes the schema- and object-level privileges that the
--         Supabase API roles (anon, authenticated, service_role) need, and the
--         dump is restored with --no-acl so those grants are NOT recreated.
--         Without this, PostgREST returns "permission denied for schema public"
--         and the staging app's API is dead. These are the standard Supabase
--         public-schema grants.
--
-- Idempotent: safe to run repeatedly.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres, anon, authenticated, service_role;

-- Future objects created in public (e.g. by a later migration) inherit the grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
