# RAG Service

The RAG (Retrieval-Augmented Generation) service runs in a **separate Supabase project** from the main app. See spec §6 for the full design.

## Why separate?

- Independent scaling: vector similarity queries have different load patterns than transactional app queries
- Security isolation: RAG credentials are scoped to RAG data only
- Schema evolution: RAG schema changes don't require main app migrations
- Independent deployment without main app downtime

## Schema overview

| Table | Purpose |
|---|---|
| `tenant_registry` | Lightweight mirror of main app tenants, synced via lifecycle webhook (§6.2) |
| `knowledge_chunks` | Vector-embedded content chunks with authority scoring, promo lifecycle, and feedback tracking (§6.4, §6.7, §6.10) |
| `knowledge_ingestion_queue` | Pending chunks awaiting normalization + review before promotion (§6.5) |
| `rag_retrieval_log` | Per-query retrieval audit log for monitoring and feedback collection (§6.6) |
| `knowledge_chunk_feedback_events` | Thumbs-up/down feedback signals linked to specific chunks (§6.10) |
| `platform_settings` | Replica of main app's platform_settings; local copy so `compute_feedback_factor()` can run as plpgsql (§6.10) |

## Tenant isolation

The RAG service uses **service-role** for all database access. Tenant isolation is enforced in application code, not via RLS. Every retrieval query includes:

```sql
WHERE scope = 'global'
   OR (scope = 'tenant' AND tenant_id = caller_tenant_id)
```

See `apps/rag/db/rls-snapshot.sql` for the documented exception.

## platform_settings replication (D-041)

The `platform_settings` table lives canonically in the **main app's** Supabase project (§6.10). The `compute_feedback_factor()` plpgsql function reads it, but cross-database queries are not possible in Postgres.

**Resolution chosen: option C** — replicate the table into the RAG project. The canonical values live in the main app; this replica is kept current by:
- A nightly sync job (deferred — not yet implemented)
- An on-change webhook from the main app's platform admin console (deferred)

Until the sync mechanism lands, update the replica manually after any platform admin knob change.

## Environment variables

```
NEXT_PUBLIC_SUPABASE_URL         RAG project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY    RAG project anon key
SUPABASE_SERVICE_ROLE_KEY        RAG project service-role key
OPENAI_API_KEY                   For embedding generation
OPENAI_EMBEDDING_MODEL           Default: text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS      Required: 1536
```

## Running migrations

```bash
SUPABASE_DB_URL=$SUPABASE_RAG_DB_URL \
MIGRATIONS_DIR=apps/rag/supabase/migrations \
pnpm db:migrate
```
