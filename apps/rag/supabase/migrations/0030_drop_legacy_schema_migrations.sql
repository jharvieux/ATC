-- #1078 follow-up — retire the vestigial public.schema_migrations ledger (RAG).
--
-- Same rationale as the main-DB drop (20260704000001): public.schema_migrations
-- was the old scripts/db-migrate.ts ledger, retired in #1078. Already dropped from
-- the rag DB out-of-band; this makes the retirement durable for fresh builds. Zero
-- readers; Supabase's own supabase_migrations.schema_migrations is untouched.
--
-- IF EXISTS makes this a no-op where the table was never created. 0026 now guards
-- its RLS-enable of this table with IF EXISTS as well.
drop table if exists public.schema_migrations;
