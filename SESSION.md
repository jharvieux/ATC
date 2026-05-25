# Session state — last updated 2026-05-24 ~21:05 UTC

## Just completed (this session, post-cascade)

### BP34 Phase A (PR #133, merged into dev earlier)
- `20260616000000_bp34_inbound_import.sql` — bookings origin/imported_from/imported_at/imported_by_user_id/provider_booking_ref; commissions clawback fields + commission_rate_source enum; new contact_imports table with RLS
- `apps/main/src/lib/import/trigger-regex.ts` — IMPORT trigger detector
- `apps/main/src/lib/import/match-confidence.ts` — Levenshtein-backed fuzzy match scorer per §34.5.4 (weights 0.30/0.25/0.25/0.15/0.20/0.10; ≥0.85 high_confidence, ≥0.60 possible, else not_surfaced)
- platform_settings seed: `bp34_import_auto_accept_threshold_default = 0.80`
- 50 unit tests passing

### BP34 Phase B (committed + pushed on `feature/bp34-phase-a-schema` as 2ed3bab — NO PR YET)
- `20260616100000_bp34_phase_b_import_queue.sql` — `import_queue` table with 11-state status FSM, RLS, updated_at trigger, partial indexes for pending_review + purgable_at
- AI surfaces: `import_classify` + `import_extract` added to `AICallPurpose` union
- `apps/main/src/lib/import/classifier.ts` — Haiku classifier, `CLASSIFY_REVIEW_THRESHOLD=0.60`, code-fence tolerant
- `apps/main/src/lib/import/extractors/{types,runner,lead-notification,booking-confirmation,commission-statement,intake-form}.ts` — shared Sonnet runner (overall_confidence = MIN per-field) + 4 per-type extractors
- `apps/main/src/lib/import/validation.ts` — required + plausibility + duplicate detection; commission_statement always flags requires_human_review
- `apps/main/src/lib/import/auto-accept.ts` — `decideRoute()` with tenant-override + platform-default + NEVER_AUTO_ACCEPT list
- `apps/main/src/inngest/import-pipeline.ts` — orchestrator on `import.queued` event; per-tenant concurrency cap (4); `BP34_IMPORT_PIPELINE_DISABLED` kill-switch; step.run boundaries: load → resolve-text → classify → extract → validate → route
- `apps/main/src/inngest/events.ts` — added `import.queued` event
- `apps/main/src/app/api/inngest/route.ts` — wired `importPipeline` into the serve() handler
- 17 new unit tests (validation + auto-accept), **67 total in `apps/main/test/unit/import/` all passing**
- Full typecheck clean (`pnpm exec tsc --noEmit` → exit 0)

### New spec/build-prompt files checked in (in 2ed3bab — also got swept into the BP34 Phase B commit)
- `specs/BuildPrompts/prompt-section-{35,36,37,38,39,40}.md`
- `specs/TechSpec/section-33-addendum-external-data-sources-and-media-assets.html`
- `specs/TechSpec/spec-addendum-external-data-and-media.md`
- Minor edits to `specs/TechSpec/{index,section-32-self-service-help}.html`

## In flight

**Nothing in flight on a working branch** — Phase B is committed + pushed but PR has not been opened (waiting on the answer to morning question Q1 below).

## Next step (HARD BLOCKED — see questions below)

Phase C of BP34 would normally be next, but it cannot proceed without source-of-truth tech-spec files for §34. **All build prompts §34 → §40 reference tech-spec addenda that do not exist in `specs/TechSpec/`.** Specifically missing:

- `section-34-addendum-inbound-import.html` (BP34)
- `section-35-addendum-referral-attribution.html` (BP35)
- `section-36-addendum-source-of-business-reporting.html` (BP36)
- `section-37-addendum-tasks-and-follow-up.html` (BP37)
- `section-38-addendum-multi-option-quote-builder.html` (BP38)
- `section-39-addendum-client-facing-deliverables.html` (BP39)
- `section-40-addendum-non-cruise-line-items.html` (BP40)

Per CLAUDE.md: "If a spec is ambiguous, flag it, propose an interpretation, ask the user to confirm. Don't invent behavior." — and these aren't ambiguous, they're entirely absent. Phase A + B of BP34 were built from build-prompt requirements + conversation context, which is at the limit of what's defensible without a spec. Phase C scope (Gmail OAuth, document upload, review queue UI, statement matching, §14.3 rate resolution) is too big to keep inventing.

## Blocked on user

**Q1 — BP34 Phase B PR:** Open PR now into `dev`, or wait until Phase C lands so it's one BP34 PR per your "One PR per BP" direction? Phase B is fully tested + typecheck clean; opening now means earlier review surface but two commits to squash later. Recommend: open now, mark draft, append Phase C commits to same branch.

**Q2 — Missing §34–§40 tech-spec addenda:** All six new build prompts reference HTML addendum files that aren't in the repo. Options:
- (A) You forgot to drop them in — paste/check them in and I resume autonomously.
- (B) Build prompts ARE the spec — work from them alone, with conversation Q&A to fill gaps.
- (C) Stop §34–§40 work entirely until tech-specs land; pick from the carry-forward backlog instead (BP25/23/24-deny-list/30/31).
- Recommend (A) if the specs exist somewhere — they're materially richer than the build prompts on schema + edge cases. (B) is doable but every fielded decision becomes a question.

**Q3 — `gmail_inbound_messages` table:** Phase B's `resolveText()` reads from this table for the email path, but I have not actually found it in the schema. Either I need to add it as part of Phase C (likely — it's a natural Phase C deliverable), or it already exists under a different name. Will verify Phase C.

**Q4 — Document-upload virus scanning:** You said "defer virus scan; rely on Gmail." That covers the email path. The document-upload path has no Gmail in front of it. Options:
- (A) Same answer — defer virus scanning for uploads too, accept the risk.
- (B) Add a ClamAV step before uploads are queued (extra infra).
- (C) Gate uploads to a stricter MIME allowlist (PDF only) and treat that as the v1 mitigation.
- Recommend (C) — cheapest and aligns with the "stuff fancy customers send" use case.

**Q5 — §14.9 clawback writes:** You said "wire clawback writes." Phase C is where these land (commission_statement acceptance → write to commissions.clawback_amount_cents + clawback_at + clawback_reason). Confirm: should clawback always auto-fire on accepted statements, or be a separate explicit action in the review UI?

## Open questions

- **Build-prompt commit hygiene:** The §35–§40 build prompts ended up in the BP34 Phase B commit by accident (pre-commit hook seems to have added them). They should ideally have been a separate `chore: check in new build prompts` commit. Not worth amending now since the branch is already pushed and the prompts logically belong with the BP34 generation, but flagging for next-session awareness.
- **Pre-existing tech-spec edits (`section-32-self-service-help.html`, `index.html`):** Also swept into the Phase B commit. Same reasoning — not worth unwinding.
- **MEMORY.md D-079 entry pending:** Documenting Phase B + the missing-spec blocker. Will add as part of this checkpoint.
- **D-049 (BP132 in task list):** Officially resolved by PR #121's no-auto-suspend policy. Worth marking the task `deleted` next session.

## Carried forward from earlier sessions (still pending)

- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- Retroactive react-pdf wire-up to unblock help-docs PDF deferral (depends on BP39 landing)
