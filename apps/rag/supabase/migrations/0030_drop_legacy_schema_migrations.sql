-- #1078 follow-up — retire public.schema_migrations (RAG DB).
--
-- Same rationale as the main-DB drop: public.schema_migrations was the old
-- scripts/db-migrate.ts ledger, retired in #1078. Nothing creates it on fresh RAG
-- DBs and it has zero readers; drop it so the RAG DB matches db/rls-snapshot-rag.sql
-- (which no longer lists it). 0026 now guards its RLS-enable with IF EXISTS.
--
-- IF EXISTS makes this a no-op on fresh DBs. Supabase's own
-- supabase_migrations.schema_migrations tracking is untouched.
drop table if exists public.schema_migrations;
