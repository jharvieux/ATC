# Build Prompt — Section 38: Multi-Option Quote Builder

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build is a multi-deploy expand-migrate-contract schema migration on a live table (the existing `quotes`), with backfill logic, dual-write coordination, and side-by-side customer-facing UI. The schema migration in particular is high-risk and benefits from Opus's reasoning depth. Do not start with Sonnet, Haiku, or any non-Opus model.

---

## What you're building

A multi-option quote builder: a quote container holding 1-5 options that customers compare side-by-side and select from. Includes the schema migration from the existing single-option `quotes` table.

## Primary spec reference

`section-38-addendum-multi-option-quote-builder.html` — full specification including the expand-migrate-contract sequence, side-by-side ASCII layout, line-item breakdown rules, and AI co-pilot integration.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — existing `quotes` table you're decomposing
- `section-09-ai-personas.html#s9-6` — generate_quote tool you're extending
- `section-10-ai-supervisor.html` — supervisor preflight for AI quote generation
- `section-11-customer-memory.html` — context for AI pro/con generation
- `section-12-crm.html#s12-4` — current quote lifecycle states (still apply at container level)
- `section-12-crm.html#s12-5` — line item categories
- `section-13-host-agency-abstraction-layer.html` — branding for PDF
- `section-14-commissions-splits-payouts.html#s14-0` — money rules (cents, rounding)
- `section-20-booking-flow.html#s20-4` — booking-flow co-pilot pattern; mirror for quote builder
- `section-21-rag-knowledge-base-consumer-side.html#s21-10` — pricing-confidence guards; ESTIMATE marker
- `section-27-saas-abuse-monitoring-cost-controls.html` — AI cost attribution for customer-side chat
- `section-33-addendum-external-data-sources-and-media-assets.html#s33-2` — cached pricing source for auto-fill
- `section-35-addendum-referral-attribution.html#s35-6-2` — quote-to-booking attribution carry-through

## Build order — MIGRATION SAFETY CRITICAL

**This build spans 2-3 deploy cycles. Do not collapse into one deploy.**

### Deploy 1: Expand
1. Create `quote_options` table per §38.2.1. RLS enabled. Indexes including the partial unique index on `customer_selected=TRUE`.
2. Add new columns to `quotes`: `customer_facing_intro`, `show_recommendation`, `recommendation_rationale`. Keep existing option-specific columns in place.
3. Application code starts DOUBLE-WRITING: new quote creation writes to both `quotes` option-specific columns AND `quote_options`. Reads still come from `quotes`.

### Backfill (between deploys)
4. Run backfill job: for each existing `quotes` row, create one `quote_options` row with `option_index=1` copying the option-specific values. Validate no rows missing.

### Deploy 2: Migrate
5. Application code switches READS to `quote_options`. Continue double-writing.
6. Verification window: 1-2 weeks. Verify all reads correct; verify totals match between old columns and new rows.

### Deploy 3: Contract
7. Application code stops writing the option-specific columns on `quotes`.
8. Migration drops the now-unused columns from `quotes`.

### Feature implementation (parallel with migration where possible)
9. Multi-option quote builder UI per §38.3.1. Up to 5 options. Add-option button. Form copies passenger_count + departure_port from prior option.
10. Recommendation marker — `is_recommended` flag, `show_recommendation` on container, `recommendation_rationale` text. UI defensively suppresses marker if zero or multiple options marked.
11. Line-item validation per §38.5: sum of line_items must match `total_amount_cents`; sum of commissionable items must match `commissionable_fare_cents`. Block quote send on mismatch (with $1 tolerance per §38.10).
12. AI co-pilot in builder per §38.8: suggest third option, auto-fill line items from cached pricing, generate pros/cons, draft intro/rationale, validate option diversity.
13. AI generate_quote tool extension per §38.3.2 — accept multi-option input schema; supervisor preflight per §10.
14. Customer-facing display per §38.4: side-by-side layout (up to 5 columns); recommendation marker; per-option breakdown collapsibles; pros/cons.
15. Customer selection flow per §38.4.3: select → unique-flag enforced → quote status='accepted' → route to booking pre-filled.
16. Decline path per §38.4.4.
17. PDF generation per §38.6: landscape multi-page; per-option detail; ESTIMATE marker.
18. Customer-side AI per §38.8.1: load all options into AI context; persona-scoped; cannot modify or quote new bookings.
19. Quote-to-booking attribution per §35.6.2: booking reads fresh from contact's latest touch, not quote's conversion_touch.
20. Tier gating per §38.9: BYO Research max 1 option.

## Required tests

- Single-option quote still valid (N=1)
- Up to 5 options supported; 6+ rejected at UI
- Backfill job creates exactly one quote_options row per existing quote with correct values
- During dual-write window: writes to `quotes` columns AND `quote_options` agree
- Reads after switchover produce identical values to reads before switchover
- Unique partial index: cannot set `customer_selected=TRUE` on two options of same quote
- Line item sum mismatch (off by $5) blocks quote send with clear error
- Line item sum mismatch within $1 tolerance shows warning but allows send
- Customer selects option, then revisits and selects different option (before booking init): prior unselected, new selected
- After booking initiated against option: switching requires agent intervention
- Decline path: status='declined', declined_reason captured, follow-up task created
- AI multi-option generation: prices come from `search_host_inventory` tool calls (not hallucinated); arithmetic check passes
- Recommendation marker: shown only when exactly one option is_recommended AND show_recommendation=true
- PDF: ≥2 options → landscape; 1 option → portrait acceptable
- BYO Research: option count capped at 1 (UI gates)
- Customer-side AI: cannot create new quote; cannot expose commission; can answer comparison questions

## Hand-off to other sections

- §35 attribution: booking creation reads fresh from contact's latest touch. Verify §35.6.2 behavior with multi-option quotes.
- §40 line items: this section's `quotes.line_items` JSONB pattern is referenced by §40 — line items in §40 are "trip components" while line items here are "fare breakdown." Different concepts despite similar names. Coordinate at build time to avoid confusion.

## Open items deferred at build time

- Per-option view tracking (`option_viewed_at`) — schema field deferred; add if analytics demand
- 5-option cap UX — soft decision; revisit after tenant feedback

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: schema migration through Contract phase, multi-option builder UI live, customer-side comparison view live, PDF generation working for both single and multi-option, AI co-pilot extended, customer-side chat context loaded with all options, line-item validation enforced (with tolerance), and tier gating applied. Explicitly note completion of the migration sequence — the migration is not done until columns are dropped from `quotes`.
