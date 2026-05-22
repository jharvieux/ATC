# Session state — last updated 2026-05-22 19:05 UTC

## Just completed

- BP22 — RAG ingestion pipeline (§22) — MERGED to dev as PR #66 (commit 7eb9951)
  - Branch: feature/bp22-rag-ingestion (deleted post-merge)
  - Migration 20260601000000_rag_ingestion.sql:
    - rag_submissions table (six submission methods, 4-stage pipeline state)
    - rag_global_promotions table (with demote tracking)
    - tenants additions for PII aggregation state (4 columns)
    - Indexes: review_queue, content_hash dedup, auto_flagged, tenant_suggested
    - Standard four-policy RLS pattern
  - Submission endpoints (six methods):
    - /api/rag/submit/web-ui (text)
    - /api/rag/submit/file (multipart, Supabase Storage upload)
    - /api/rag/submit/extension (browser ext OAuth)
    - /api/rag/submit/ios-shortcut (text or 307 redirect for multipart)
    - /api/rag/submit/batch (atomic 100-item batch)
    - manual_entry shares the web-ui endpoint via 'via' param
  - Four-stage Inngest pipeline:
    - rag-extract-content (file MIME dispatch; text/plain + text/markdown real, binary formats stubbed pending operator install)
    - rag-pii-redact (regex zero-tolerance prefilter + Haiku tolerable redaction)
    - rag-normalize (Haiku structured output + auto-flag threshold)
    - tenants approval rate nightly
  - PII quarantine aggregation:
    - pii-quarantine-aggregator.ts pure function
    - Window-based alert send/update logic
    - 3-consecutive-day → tenant.rag_pii_recurring_pattern_detected event for BP27
  - Tenant review queue:
    - GET /api/rag/queue (paginated, filterable)
    - POST /api/rag/queue/[id]/approve (two-step RAG forward)
    - POST /api/rag/queue/[id]/reject (with abuse-signal event)
    - POST /api/rag/queue/bulk-approve (10-item safety prompt header)
    - GET /api/rag/queue/[id]/duplicate-check
    - POST /api/rag/queue/[id]/duplicate-action (replace/add_with_supersedes/cancel)
  - Global review queue:
    - GET /api/admin/rag/global-review (four tabs, withPlatformAdminAudit)
    - POST /api/admin/rag/promote/[submission_id] (creates rag_global_promotions row)
    - POST /api/admin/rag/demote/[promotion_id] (to_tenant_scope | hard_delete)
  - Browser extension + iOS shortcut docs in docs/rag/
  - 3 new test files, 20 new unit tests (417/417 passing)
  - MEMORY.md D-054 added (12 decisions documented)

## In flight

- Nothing in flight — clean checkpoint

## Next step

- Proceed to BP23 — Email infrastructure, pre-cruise series, in-app notifications (§23). Uses Sonnet per build prompt.

## Blocked on user

- Apply BP22 migration to atc-main: `SUPABASE_DB_URL=<url> pnpm db:migrate`
- Decide on RAG_INGEST_OCR_PROVIDER ('tesseract' | 'gcv') — currently 'none' = images & OCR-only PDFs fail
- Approve file parser library installs (pdf-parse, mammoth, sheetjs, pptxgenjs reader, cheerio) when binary uploads are needed
- Provision Supabase Storage bucket 'rag-submissions' (one-time)
- Env vars to add to Vercel (atc-main) for BP22:
  - RAG_INGEST_PII_REDACTION_HAIKU_MODEL (default claude-haiku-4-5-20251001)
  - RAG_INGEST_NORMALIZATION_HAIKU_MODEL (default claude-haiku-4-5-20251001)
  - RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD (default 0.6)
  - RAG_INGEST_AGGREGATION_WINDOW_HOURS (default 24)
  - RAG_INGEST_RECURRING_PATTERN_DAYS (default 3)
  - RAG_INGEST_MAX_FILE_SIZE_BYTES (default 52428800)
  - RAG_INGEST_OCR_PROVIDER (default 'none' — set when chosen)
  - GCV_API_KEY (only if 'gcv')
- Carry-over from BP21:
  - ANTHROPIC_API_KEY (Haiku entity extraction + claim grounding)
  - All quote pricing + RAG-consumer env vars
- Carry-over from BP20: forum, group, OAuth, Redis, Stripe price IDs, etc.

## Open questions

- File parsers gated on operator install of pdf-parse / mammoth / sheetjs / pptxgenjs / cheerio
- OCR provider operator decision pending
- /replace/chunk and /demote/chunk RAG endpoints not yet built (501 / 404 fallback in main app)
- BP27 abuse signals will consume tenant.rag_pii_recurring_pattern_detected event
- BP27 abuse signals will consume tenant.rag_submission_rejected event
- audit_log table real-INSERT swap when §26 lands (D-036, D-053, D-054 stub patterns)
- Carry-overs from prior BPs (Slur deny-list, BrandedLayout, persona-drift v2, etc.)
