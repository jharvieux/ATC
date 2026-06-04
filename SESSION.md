# Session state — last updated 2026-06-04 PM

## Just completed
- **PR #688 merged** — OpenAI Batch API for RAG-ingest embeddings (issue #686). Batch infra at `apps/rag/src/lib/embeddings/batch/`, feature flag `OPENAI_EMBEDDING_BATCH_ENABLED` default true, 3 Inngest crons (flush 10m, reconcile 5m, stale-alert daily), `pending_embedding` table, 5 ingest callsites migrated. Audits Opus×2 clean.
- **PR #691 merged** — Embedding cost telemetry + admin Resource Utilization dashboard integration (issue #689). New `rag_ai_call_log` table + `tenant_id` column on `pending_embedding`. Reconcile and sync paths both log per-row cost with tenant attribution. Dashboard route at `/api/admin/resource-utilization` reads both DBs and merges; rag-side failure is non-fatal (display falls back to main-side only). Audits Opus×2 clean.
- **Migrations 0023 + 0024 verified applied** to rag prod Supabase (`jjznkprbotkqqnuvcost`) — confirmed column-by-column via MCP. Issue #690 closed.
- **atc-main Inngest sync DONE** earlier this session — all ~95 functions visible.
- **Inngest dashboard troubleshooting** for atc-main — root cause was unregistered App URL, not a key problem.
- **MEMORY D-151 added** — canonical `SUPABASE_RAG_*` env var pattern, no fallback in new code.
- **Vercel atc-rag Production env** — added `SUPABASE_RAG_URL` + `SUPABASE_RAG_SERVICE_ROLE_KEY` (mirrors of the canonical names; pulled service-role key from `.env.local` without echoing).
- **Rag prod deployed for the first time** — `vercel deploy --prod` ran cleanly, `https://rag.ai-travelconcierge.com` aliased, `/api/inngest` responds with `x-inngest-sdk-handled: true` and the expected SDK auth challenge.

## In flight
- Nothing in flight — clean checkpoint.

## Next step
- **User to sync rag in Inngest dashboard.** Env switcher → Production → Apps → Sync new app → `https://rag.ai-travelconcierge.com/api/inngest`. Within seconds, 10 functions should appear (7 existing rag crons + the 3 from PR #688). If sync fails with auth error, verify the Inngest Production-env signing key matches `INNGEST_SIGNING_KEY` in Vercel atc-rag prod.

## Blocked on user
- Final Inngest sync step above.

## Open questions
- **Cost-limit enforcement (#692)** — embedding cost is DISPLAYED in the tenant proximity row but doesn't roll into `tenant_usage_metrics` on main. Tenants generating heavy ingest won't trip their AI cost limit purely on embedding spend. Tracked as a separate issue with two suggested implementation approaches.
- **Legacy fallback cleanup (D-151)** — 4 files still carry the `NEXT_PUBLIC_SUPABASE_URL` fallback pattern (`apps/rag/src/inngest/promo-state-{reconcile,drift-alert}.ts`, `retrieval-log-aggregate.ts`, `apps/rag/src/app/api/feedback/route.ts`). Worth removing in a housekeeping PR for codebase consistency. Not opened as an issue — small enough to fix inline next time those files are touched.
- **OpenAI Batch path is now live in prod but unvalidated.** No real ingest has run yet. First batch lifecycle (`pending` → `submitted` → `done`) needs end-to-end verification — submit a small live batch via `/api/ingest/reference` after the Inngest sync.
