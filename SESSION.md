# Session state — last updated 2026-05-25 ~05:30 UTC

## Just completed — full merge cascade landed on `dev`

All 13 PRs from the BP34–BP40 overnight + UI push are merged:

| Order | PR | What |
|---|---|---|
| 1 | #133 | BP34 Inbound import pipeline (§34) |
| 2 | #134 | BP35 Referral attribution (§35) |
| 3 | #136 | BP37 Tasks & follow-up (§37) |
| 4 | #137 | BP38 Multi-option quote containers (§38) |
| 5 | #138 | BP39 Client-facing deliverables (§39) — itinerary + resources + react-pdf |
| 6 | #139 | BP40 Price-watch + non-cruise line items (§33.8 / §40) |
| 7 | #152 | BP36 Source-of-Business reporting (§36) — MV + 6 reports |
| 8 | #153 | BP35 wire-ups: bindContactOnIdentification + transfer-finalize |
| 9 | #154 | BP35 UI: contact-create form with source picker |
| 10 | #155 | BP40 UI: LineItemsPanel + Components bulk view |
| 11 | #156 | BP39 ↔ BP40: render non-cruise line items on itinerary (§40.6) |
| 12 | #157 | BP39 UI: ItineraryEditor + ResourcesEditor |
| 13 | #158 | BP36 UI: Reports dashboard (landing + 6 report pages) |

### Issues encountered + resolutions (worth remembering)

- **`packages/config/eslint-rules/no-direct-service-role-import.js`** conflicts on every rebase — each BP appends to the same allow-list. Resolution: keep both lists.
- **`apps/main/src/app/api/inngest/route.ts`** conflicts on every rebase — each BP adds an Inngest function import + registration. Resolution: keep both.
- **`db/rls-exceptions.sql` ≠ `db/rls-exceptions.txt`** — the `.sql` file is read by the Playwright RLS-coverage step; the `.txt` file is read only by the migration lint. BP34 updated only `.txt`. Cherry-picked gmail entries to `.sql` to unblock CI on downstream PRs.
- **Storage-bucket migrations** need `IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='storage') THEN ... END IF;` because the CI test DB lacks the `storage` schema.
- **`SECURITY DEFINER` migrations** must use `SET search_path = ''` (empty) + `REVOKE EXECUTE ... FROM public` (not `REVOKE ALL`).
- **RLS lint scans only static `CREATE POLICY` blocks** — no `DO $$ ... EXECUTE format() $$;` loops.
- **Stacked PRs (#145, #146, #149) auto-closed** when their base feature branches got deleted on merge. Re-created against `dev` as #156, #158, #157.
- **Cross-tenant Inngest probe** flags any handler that imports both `tenantClient` and `createServiceRoleClient`. BP35 wire-ups added a service-role call inside `transfer-finalize` next to the existing tenantClient work. Added `// INNGEST-PROBE-ALLOW-MIXED:` comment with justification.
- **Next.js 14 `useSearchParams()`** must be wrapped in `<Suspense>` for static prerender. BP36 UI's 6 report pages all needed wrapping.
- **Flaky test:** `runSupervisor — sampling integration (§10.5a)` 30s timeout on `simulates ~1% sampling rate for clean passes over 1000 runs` — pre-existing on `dev`, intermittent. Reran twice on #158 before passing; #156 also retried once. Filed as follow-up #148-style work.

## In flight

**Nothing in flight.** Working tree is on `dev`, clean and synced.

## Next step

1. Decide on stale PRs (do NOT close without user OK):
   - **#140** chore: SESSION.md + MEMORY.md overnight queue — superseded by this update; recommend close.
   - **#102, #78, #76** older SESSION.md snapshot PRs — recommend close.
   - **#132** docs(specs) check-in for sections 34-40 — specs are already in dev; recommend close.
   - **#52** BP14 Host agency abstraction — much older, never finalized; recommend defer or close.
   - **#11, #10, #9, #30, #55, #111** Dependabot PRs — separate cadence, evaluate as needed.
   - **chore/session-checkpoint-merge-cascade** local branch was created mid-session (couldn't push directly to dev); it was a placeholder for this very SESSION.md. Safe to delete once this update lands.
2. Address follow-ups captured during the cascade:
   - **`tests/e2e/quotes.spec.ts:54`** — Playwright spec expects `quote.cruise_line === "Royal Caribbean"` but after BP38 `cruise_line` lives on `quote_options`. Test or response shape needs update. (Playwright is non-required, so not blocking.)
   - **`apps/main/test/integration/supervisor/run-supervisor.test.ts`** — sampling test 30s timeout is flaky. Either bump per-test timeout or split the 1000-iteration loop.

## Blocked on user

Nothing.

## Open questions / observations

- Required CI gates worked well — Playwright + Vercel failed on every PR but were non-required, so they didn't block. Worth confirming whether Playwright should become required after stabilizing the quotes regression + supervisor flake.
- Vercel checks failed consistently — looks like rate-limit / external auth issue rather than per-PR problem. Worth investigating before the deploy pipeline matters.

## Carried forward (deferred work)

- BP39 follow-up: retroactive react-pdf wire-up to unblock help-docs PDF deferral
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
