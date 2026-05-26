# Session state — last updated 2026-05-25 ~22:35 UTC

## Just completed

Three-PR sweep closing items 1-5 of `docs/specs/reality-delta-supplement.md`:

| PR | What | Status |
|---|---|---|
| #204 | §29.14 DR runbook + §30.7 k6 scripts (×6) + §14.11 supplement correction (false positive: Stripe Connect handles 1099-NEC) | Merged |
| #205 | §16/§9/§22.5 — branding form + persona editor + RAG queue UI pages | Merged |
| #206 | §32.3 — 10 missing help docs + 2 quickstarts + tier-aware loader extension | Open, CI pending |

### Highlights

- **§14.11 was a false positive** — Stripe Connect Express handles 1099-NEC generation automatically for sub-hosts ≥ $600/year. Original delta entry struck through with paper trail kept in the supplement.
- **k6 scripts** are out-of-band per spec — CI does NOT run them. Six scenarios cover chat-sustained, signups-burst, group-invite-blast, rag-retrieval, stripe-webhook-flood, multi-tenant-fanout. Run from `tests/load/k6/` with a dedicated load-test environment.
- **DR runbook** covers all 9 §29.14 scenarios with RTO/RPO targets, monthly backup-verification cadence, and quarterly recovery-rehearsal log structure (SOC 2 prerequisite).
- **Tenant UI pages** use only existing API routes (`/api/tenant/branding`, `/api/tenant/personas/*`, `/api/rag/queue/*`) — no schema changes, no new endpoints.
- **Help docs loader extended** to parse `tiers: [...]` frontmatter and filter via `listDocsForTier(tierCode)`. Docs without `tiers:` are treated as universal (so tier reorganizations don't accidentally hide content). New `[Screenshot: ...]` placeholders throughout for an operator-led content pass.

## In flight

**Nothing in flight.** PR #206 is open with CI running but the diff is closed (no further edits expected unless a check fails).

## Next step

When PR #206 lands: items 1-5 of the reality-delta-supplement are closed. Remaining backlog from the supplement is whatever items 6+ are — re-read the file to confirm.

A few notes the user may want to follow up on:

- **Help-center route wiring** — `listDocsForTier()` was added but not yet wired into the `/admin/help` page; today that page calls `listDocs()` which returns everything. Wiring change is small; deferred to keep PR C focused on content.
- **Tenant-side help docs route** — `/admin/help` is the operator-facing route; the tenant-facing one (if separate) may also need the tier filter wired.
- **Branding page custom domain** — today's UI surfaces a `mailto:support@…` because no self-serve custom-domain endpoint exists yet. If/when an endpoint ships, the page should switch from email to form.
- **Persona addendum tier-gate copy** — the page returns the tier-blocked message on any 403 from the API. The API currently 403s for non-Pro tiers; if the tier mapping changes, the copy may need a refresh.

## Blocked on user

Nothing.

## Open questions

- Should the help docs page actually call `listDocsForTier(currentTenantTier)` now? It's a 2-line change in the help route handler — was deferred to keep the help-doc content PR self-contained.
- The branding UI has no real-time tier check, so the "forced powered-by" state is inferred from the server response. Good enough for now; cleaner would be a dedicated tier-fetch endpoint.

## Carried forward (deferred work, unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up to unblock help-docs PDF deferral
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
