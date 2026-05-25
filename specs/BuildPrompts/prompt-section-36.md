# Build Prompt — Section 36: Source-of-Business Reporting

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves materialized view design with concurrent refresh requirements, multi-table aggregation queries, and a new enum that integrates with cancellation flows. Opus's reasoning depth is needed to get the query shapes and refresh semantics right. Do not start with Sonnet, Haiku, or any non-Opus model.

---

## What you're building

A reporting dashboard with six standard reports answering source-of-business questions, plus the new cancellation reason category enum and a nightly materialized view backing high-volume reports.

## Primary spec reference

`section-36-addendum-source-of-business-reporting.html` — full specification including report definitions, MV refresh cadence, query shapes, and dashboard UX.

## Dependencies — must land before §36

- **§35 (Referral Source Attribution)** — produces the `first_touch_*` and `conversion_touch_*` columns that §36 reports group by. §36 cannot ship until §35 has populated these.
- **§34 (Inbound Import)** — adds `clawback_*` fields to `commissions`. §36.7's clawback measure depends on these being populated by §14.9 clawback handling.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — base contacts/quotes/bookings/commissions tables
- `section-12-crm.html` — quote lifecycle states (filter conditions in MV)
- `section-14-commissions-splits-payouts.html` — commission state values; §14.9 clawback handling
- `section-20-booking-flow.html#s20-9` — cancellation flow (where new category enum is set)
- `section-23-email-notifications.html` — large-export-ready notifications
- `section-24-chat-ui.html` — UX patterns to follow for the reports dashboard
- `section-25-data-privacy-retention.html` — date-range maximum bounded by retention
- `section-26-security.html` — service-role discipline (§26.3a) for MV refresh
- `section-27-saas-abuse-monitoring-cost-controls.html` — async-export rate budgeting
- `section-34-addendum-inbound-import.html#s34-8` — clawback fields used by report

## Build order

1. **Cancellation category enum** — Per §36.5: ALTER TABLE `bookings` ADD COLUMN `cancellation_reason_category` with 8-value CHECK. Index on (tenant_id, category) WHERE NOT NULL.
2. **Cancellation flow integration** — Update §20.9 cancellation UI to surface the new dropdown alongside the existing free-text reason. Add the Haiku-backed category suggestion call (with accept/override).
3. **Campaigns table** — Per §36.4: new `public.campaigns` table with RLS per §5.1. Tenant settings UI for managing campaign cost entries.
4. **Materialized view** — Per §36.6.1: `attribution_rollup` MV with unique index required for CONCURRENTLY. Tenant-scoped query indexes. Verify the GROUP BY covers all dimension columns.
5. **Nightly refresh job** — Per §36.6.2: Inngest scheduled function at `0 3 * * *` UTC, calling `REFRESH MATERIALIZED VIEW CONCURRENTLY`. Use service-role DB client per §26.3a.
6. **Live query reports** — Per §36.6.4: First-touch-vs-last-touch and Cancellations reports query base tables, not MV.
7. **Lost Revenue from Cancellations report** — Per §36.7: SQL shape provided in §36.7.4. Default group by category; secondary groupings per §36.7.2. Drill-down to bookings list per §36.7.3.
8. **Other 5 reports** — Per §36.2 table: Leads, Bookings, Funnel, Campaign, First/Last comparison.
9. **Date filtering and grouping** — Per §36.3: trailing-90-day default, user-adjustable; date field varies by report.
10. **CSV export** — Synchronous up to 10k rows; async with email notification beyond that. Money as decimal dollars + currency column per §36.8.
11. **Dashboard UX** — Reports nav entry, six report pages, charts + tables, last-refreshed / live indicators.
12. **Tier gating** — Per §36.10: all reports excluded for BYO Research.

## Required tests

- MV refresh CONCURRENTLY does not block reads
- MV refresh completes nightly; if missed (e.g., service down), next-run picks up
- Report dimensions match §35-captured field names exactly (no shifted column names)
- Cancellation enum: 8 values per §36.5; NULL displays as 'uncategorized' in report
- Haiku-suggested category present but agent can override or skip
- Lost expected commission only includes rows where `received_commission_cents = 0` (commission never received)
- Clawback measure sums `clawback_amount_cents` — verify this is non-zero only when §14.9 + §34.8 are wired correctly
- Net financial impact = lost expected + clawback (validate the math in test fixtures)
- Drill-down from aggregated row to individual booking list respects RLS
- Date range filter on `created_at` for Leads/Bookings/Funnel; `cancelled_at` for Cancellations
- Multi-touch journey: contact with first_touch from FB, conversion_touch from Email → appears in First/Last comparison report under (FB, Email) pair
- Campaign with no cost set: cost-per-lead displays 'not set', not zero
- Async export sends email notification when ready
- Synchronous export at 10,001 rows correctly routes to async
- BYO Research tenant: reports page returns 404 / not available
- Cross-tenant RLS: tenant A's reports never include tenant B's data

## Hand-off to other sections

- §14.9 must populate the new `clawback_*` fields on `commissions`. This is the cross-build coordination flagged in both §34 and §36. Acceptance test: process a test cancellation that triggers a clawback, verify the fields are written, verify the §36.7 report includes the clawback in measure.

## Open items deferred at build time

- Cancellation category evolution (review after 6 months of real data)
- Tenant feedback on Haiku suggestion accuracy → potential retraining or rule refinement
- MV partitioning by tenant_id if scale becomes a problem (not v1)

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: enum applied, MV created and refreshing nightly, all 6 reports functional, CSV export (sync + async) working, drill-downs respecting RLS, and clawback measure verified end-to-end with a test cancellation through §14.9.
