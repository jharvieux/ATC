# Build Prompt — Section 34: Inbound Import (Email / Document / Manual)

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves cross-cutting schema changes, AI-driven document parsing pipelines, and modifications to commission rate resolution logic — all areas where Opus's reasoning depth materially reduces correctness risk. Do not start with Sonnet, Haiku, or any non-Opus model. If you are currently on a different model, stop and switch before proceeding.

---

## What you're building

The Inbound Import surface — three intake paths (Gmail-trigger email forwarding, document upload, manual entry) feeding a unified parsing pipeline that creates contacts and bookings-of-record-elsewhere. Includes a §14.3 adjustment for imported bookings' commission rate resolution.

## Primary spec reference

`section-34-addendum-inbound-import.html` — full specification with schema, parsing pipeline, review queue UX, and the §14.3 adjustment in §34.7.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — base schema for contacts and bookings; understand existing column set before adding the new ones
- `section-09-ai-personas.html` — message processing flow for the email path
- `section-12-crm.html` — contacts/quotes/bookings tables this addendum extends
- `section-13-host-agency-abstraction-layer.html` — host adapter interface; commission rate fallback step 2 uses this
- `section-14-commissions-splits-payouts.html` — full §14.3 rate-locking logic and §14.8 statement reconciliation; §34.7 is an adjustment to §14.3, not a replacement
- `section-22-knowledge-ingestion-rag-submission-side.html` — Sonnet/Haiku structured tool output patterns for classification and extraction
- `section-23-email-notifications.html` — Gmail integration health states
- `section-26-security.html` — prompt-injection screening rules for document content (§26.8)
- `section-27-saas-abuse-monitoring-cost-controls.html` — AI cost attribution per tenant

## Build order

1. **Schema migrations** — Apply per §34.8:
   - `bookings`: ADD COLUMN `origin`, `imported_from`, `imported_at`, `imported_by_user_id`, `provider_booking_ref` + the new index on `provider_booking_ref`.
   - `commissions`: ADD COLUMN `commission_rate_source` (with the four-value CHECK), `clawback_amount_cents`, `clawback_at`, `clawback_reason`.
   - New table `contact_imports` with RLS enabled per §5.1.
2. **Gmail trigger detection** — Implement the regex check (§34.2.2) as the first step in inbound Gmail message processing, before persona response logic.
3. **Virus scan service** — Stand up ClamAV sidecar (or wire Supabase native scanning if available); apply to all uploaded files and Gmail attachments BEFORE any parsing.
4. **Document classification** — Haiku-backed classifier with structured tool output (single enum + confidence). Route low-confidence to review queue with type='unknown'.
5. **Field extraction** — Sonnet-backed extractor with per-type schemas; per-field confidence; minimum-field-confidence as overall.
6. **Validation layer** — Required-field, plausibility, and duplicate-detection checks per §34.3.4.
7. **Auto-accept threshold** — Tenant-configurable setting (default 0.80); above-threshold + clean = direct write; below or flagged = review queue.
8. **Review queue UI** — Pending-review tab in CRM per §34.6; filters per §34.6.1; bulk-accept for high-confidence batches.
9. **§14.3 adjustment for imports** — Implement the rate resolution order in §34.7.3 (doc_parsed → host_adapter → agent_set fallback). Block import acceptance until rate resolved. Lock at import-acceptance time.
10. **Document retention** — `purge-parsed-documents` Inngest scheduled function per §34.4; daily sweep.
11. **Gmail health surfacing** — Tenant settings page status, persistent banner, owner notification email per §34.2.4.
12. **Statement matching** — Per §34.5.4: provider_booking_ref exact match preferred; fuzzy match (Levenshtein on passenger_last_name, cruise_line/ship_name/sailing_date exact or ±7 days). Surface fuzzy matches in §14.8 admin review UI.
13. **Tier gating** — Per §34.9 matrix.

## Required tests

- Trigger regex matches `IMPORT`, `Import:`, `import -`; does NOT match `IMPORTANT`, `IMPORTED`, `IMPORTING`, `imported their file`
- Virus-scan rejection writes audit_log and surfaces to agent
- Classification confidence < 0.60 routes to review with type='unknown'
- Extraction with one weak field (per-field confidence 0.40, all others 0.95) routes to review even though average is high
- Duplicate detection on (tenant_id, email) and (tenant_id, phone) for contacts; (tenant_id, cruise_line, ship, sail_date, passenger_last_names) for bookings
- Import-acceptance for booking missing all three rate sources (no parsed rate, no host adapter rate, no agent input) BLOCKS acceptance
- BYO tenant imported booking sets `platform_split_rate = NULL`
- Sub-host tenant attempt to import a booking is REJECTED at UI with clear explanation
- Commission rate from `commission_statement` document populates with `commission_rate_source = 'doc_parsed'`
- Subsequent agent edit to that rate updates `commission_rate_source = 'agent_corrected'` and writes audit_log
- `purge-parsed-documents` deletes files older than 24h with status IN ('accepted','rejected'); retains files with status='parse_failed' for 7 days
- Virus-detected files quarantined for 30 days then deleted
- Statement line item with matching `provider_booking_ref` auto-suggests via §14.8 variance thresholds
- Statement line item without ref, fuzzy match ≥ 0.85, surfaces in admin review with confidence score
- Statement line item with confidence < 0.60 treated as orphan per §14.8

## Hand-off to other sections

- §34.8 adds `clawback_amount_cents`, `clawback_at`, `clawback_reason` to `commissions`. These fields are READ by §36.7 (Lost Revenue from Cancellations). They MUST be WRITTEN by §14.9 clawback handling — verify that build coordinates this. If §14.9 ships without writing these fields, §36.7 reports zero clawback. Confirm at acceptance time.

## Open items deferred at build time

- Confidence threshold tenant configuration UI design (just functional control acceptable for v1)
- Per-tenant cost monitoring integration with §27 — should be wired but the abuse-monitoring dashboards remain owned by §27

---

## When you finish

**Switch model back to your default (or stop the model-Opus assignment).** Confirm to the user that the build is complete with a checklist of: schema migrations applied, parsing pipeline live, review queue functional, §14.3 adjustment behavior verified for imports, Gmail health surfacing live, and §34.8 clawback fields written by §14.9 (cross-build verification). Note any deferred items.
