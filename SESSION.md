# Session state — last updated 2026-05-24 ~21:40 UTC

## Just completed (this session, after specs were dropped in)

### BP34 Phases A + B + C — 9 commits on `feature/bp34-phase-a-schema`, ready for PR

After the user added the missing §34–§40 tech-spec addenda manually, I re-verified Phase B against the real §34 spec (one alignment fix: retention windows for accepted/rejected from 7d/30d → 24h per §34.4) and built Phase C end-to-end as backend.

**Code added (Phase C, 8 commits):**

| Concern | File |
|---|---|
| Retention sweep (§34.4) | `apps/main/src/inngest/purge-parsed-documents.ts` |
| Rate resolver (§34.7.3) | `apps/main/src/lib/import/resolve-commission-rate.ts` |
| Acceptance promotion (§34.5, §34.7) | `apps/main/src/lib/import/promote.ts` |
| Tier gating helper (§34.9) | `apps/main/src/lib/import/tier-gate.ts` |
| Statement matching (§34.5.4, §14.8) | `apps/main/src/lib/import/match-statement-line-items.ts` |
| Gmail trigger glue (§34.2) | `apps/main/src/lib/import/process-gmail-message.ts` |
| Manual entry route | `apps/main/src/app/api/imports/manual/route.ts` |
| Document upload route (PDF-only) | `apps/main/src/app/api/imports/upload/route.ts` |
| Review queue list | `apps/main/src/app/api/imports/review/route.ts` |
| Review accept (edit + agent rate) | `apps/main/src/app/api/imports/review/[id]/accept/route.ts` |
| Review reject | `apps/main/src/app/api/imports/review/[id]/reject/route.ts` |
| Gmail Pub/Sub webhook (real) | `apps/main/src/app/api/webhooks/gmailpubsub/route.ts` |
| Gmail health endpoint (§34.2.4) | `apps/main/src/app/api/integrations/gmail/health/route.ts` |
| Gmail health banner component | `apps/main/src/components/integrations/GmailHealthBanner.tsx` |
| §14.9 clawback writes (§34.8.2) | `apps/main/src/app/api/bookings/[id]/cancel/route.ts` |
| Schema: gmail tables + storage bucket | `apps/main/supabase/migrations/20260617000000_bp34_phase_c_gmail_storage.sql` |

**Tests:** 83 unit tests in `apps/main/test/unit/import/` (was 17 → 83). Typecheck clean throughout (every commit).

**Cross-section wires:**
- §14.9 `/api/bookings/:id/cancel` now writes `clawback_amount_cents` + `clawback_at` + `clawback_reason` on three branches (hold cancel, Stripe reversal, contractual recovery). Required by §36 reports.
- `/api/inngest` now serves `importPipeline` + `purgeParsedDocuments`.
- `inngest/events.ts` now declares `import.queued` event.

## In flight

**Nothing in flight on a working branch.** Phase A merged in PR #133. Phases B + C are committed + pushed on `feature/bp34-phase-a-schema` (HEAD = `8f5a16a`). PR not yet opened — recommendation in Q1.

## Next step

**Open the BP34 PR** (`feature/bp34-phase-a-schema` → `dev`) as draft so the user can see scope at a glance. Then handle morning Q&A on deferred Phase D items.

## Blocked on user (morning questions)

**Q1 — Open the BP34 PR now?** Branch has ~3000 LOC across Phases B+C. Recommend opening as **draft** so CI runs and you can see scope; we mark ready-for-review after Phase D's UI lands or you decide UI is a separate PR.

**Q2 — Phase D scope split.** Phase D as-listed contains a mix: Gmail health surfacing (DONE), tier gating (DONE), final tests. Plus what I deferred from Phase C: review queue UI, OAuth connect/callback, watch renewal cron, PDF OCR for document path. How do you want this split? Options:
- (A) One big "BP34 finishing" PR with everything deferred.
- (B) Three smaller PRs: (i) Review queue UI, (ii) Gmail OAuth + watch cron, (iii) PDF OCR.
- Recommend (B). Each piece has different risk profile + dependency.

**Q3 — PDF OCR dependency.** The document-upload path stores the PDF + emits import.queued but the pipeline's `resolveText('document')` returns null, so the row goes to parse_failed (correctly fail-loud). To fix it I need either:
- (A) `pdf-parse` npm dep (lightweight, text-only PDFs)
- (B) `pdfjs-dist` + OCR worker (handles scanned PDFs but heavier)
- (C) External service (Google Document AI, AWS Textract) — costs $$$
- Recommend (A) for v1; tenants forwarding scanned-PDF lead-board screenshots will see parse_failed and can re-submit as manual entry or images via Gmail.

**Q4 — Gmail OAuth setup.** The Pub/Sub webhook is wired and the trigger-detection + emit-to-pipeline flow is in. What's still needed to make Gmail import end-to-end functional:
- (A) GCP project + OAuth client + Pub/Sub topic creation (per `docs/runbooks/gmail-inbound-setup.md`) — **your task**
- (B) OAuth connect/callback endpoints (apps/main/src/app/api/integrations/gmail/connect/route.ts is still a 501 stub) — Phase D
- (C) 7-day Pub/Sub watch renewal cron — Phase D
- (D) Disconnect endpoint — Phase D
- Need (A) confirmed before (B)–(D) are testable. Will you run the runbook this week or should I defer all Gmail wiring to a later session?

**Q5 — Match-report persistence.** Commission-statement matching currently stashes the report on `import_queue.raw_extracted_fields._match_report` rather than its own table. Spec §14.8 will need a proper `commission_statement_matches` table eventually but there's no §14.8 build prompt in the repo. Acceptable to defer until §14.8 lands, or do you want a follow-up table now?

**Q6 — BP35 + beyond after BP34 PR opens.** Per your "one PR per BP" direction, BP35–40 are next. Should I start BP35 (Referral Attribution) tonight or wait for morning?

## Open questions / observations

- **Sub-host import block:** `promoteBooking()` enforces §34.7.4 by rejecting non-byo_host tenants. The intake routes (manual/upload) don't pre-check tenant_type because intake content type isn't known until classifier runs (a manual entry could be a lead, not a booking). The block is at the right layer but a more graceful UX would be to surface in the review queue with reason='sub_host_cannot_import_booking'. Phase D / UX call.
- **`gmail_inbound_messages` for non-IMPORT mail:** Phase B's `resolveText()` for email path reads from this table, which is now populated by the webhook. Non-IMPORT messages also get rows here. The "normal Gmail conversation handling" path (§23.1) doesn't exist yet — when it does, it'll read from the same table.
- **PR strategy reminder:** From D-079 — one PR per BP, all phases inside. BP34 PR will contain Phases B+C (Phase A is already merged separately as #133). That's the intent.
- **Spec re-check found one bug (retention windows).** I'm glad I read §34 before resuming. Future Phase work should re-read the relevant spec section before starting; conversation memory drift on detail values is real.

## Carried forward from earlier sessions

- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- Retroactive react-pdf wire-up to unblock help-docs PDF deferral (after BP39 lands)
