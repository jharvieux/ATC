# Build Prompt — Section 40: Non-Cruise Line Items

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves a flexible JSONB-with-type-discriminator schema, commission rollup queries across multiple tables, and integration with both the itinerary display (§39) and the cancellation/reporting flow (§36). Opus's reasoning depth is needed. Do not start with Sonnet, Haiku, or any non-Opus model.

---

## What you're building

Tracking of non-cruise ancillary items (flights, hotels, transfers, excursions, insurance, other) attached to cruise bookings, with commission accounting for cruise-line-supplied AND third-party items.

## Primary spec reference

`section-40-addendum-non-cruise-line-items.html` — full specification including schema, per-type JSONB shapes, commission handling rules, UI workflow, and itinerary integration.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — base patterns
- `section-13-host-agency-abstraction-layer.html` — host adapter may supply rates for cruise-line-supplied items
- `section-14-commissions-splits-payouts.html` — commission lifecycle this addendum mirrors (simplified)
- `section-14-commissions-splits-payouts.html#s14-8` — statement reconciliation pattern extended to line items
- `section-20-booking-flow.html` — booking detail page (where Trip Components section lives)
- `section-26-security.html` — audit_log for line item changes
- `section-34-addendum-inbound-import.html` — AI-assisted line item extraction from forwarded confirmations
- `section-34-addendum-inbound-import.html#s34-5-4` — statement parsing pattern; line items extend the matching surface
- `section-34-addendum-inbound-import.html#s34-8` — clawback fields on commissions; NOT mirrored on line items in v1
- `section-36-addendum-source-of-business-reporting.html#s36-7` — cancellations report sums lost-expected from line items
- `section-39-addendum-client-facing-deliverables.html#s39-2` — itinerary display where non-cruise items render

## Build order

1. **Schema** — Per §40.2.1: `booking_line_items` table with type-CHECK enum. RLS per §5.1. Indexes per spec.
2. **item_details JSONB shapes** — Per §40.3: per-type structures. Application-side validation that the JSONB matches the type's expected schema (Zod or equivalent). Type-appropriate dates enforced (excursion: start=end; flight: start≤end).
3. **UI: Trip Components section** — On booking detail page per §40.5.1. List by type. Add-component modal with type-adaptive form.
4. **Supplier autocomplete + "+ new supplier"** — Free-text supplier_name in v1; no separate suppliers table.
5. **Commission fields per item** — commissionable toggle; commission_rate input; auto-compute expected_commission_cents. Money rules per §14.0 (BIGINT cents).
6. **Commission rollup query** — Per §40.4.2: SQL view or query helper that sums cruise commission + ancillary commission for a booking. Use on booking detail page summary.
7. **AI-assisted extraction integration** — Per §40.5.2: extend §34 import pipeline to classify forwarded confirmation emails (flight, hotel, transfer) and route to line-item creation with associated cruise booking when detectable. Agent reviews per §34.6 queue.
8. **Bulk Components view** — Per §40.5.3: separate CRM nav entry for cross-booking line items. Filters by type, status, supplier, date range.
9. **Itinerary integration** — Coordinate with §39.2 itinerary renderer. Per §40.6: flights in "Getting there & back"; pre-cruise hotels grouped with outbound flights; excursions on corresponding port day; insurance on resources page (not itinerary); other defaults suppressed unless agent toggles "include in itinerary."
10. **Cancellation handling** — Per §40.7: when cruise booking is cancelled, prompt agent per line item (cancel / keep / convert-to-standalone). v1: convert-to-standalone deferred; cancel or keep only.
11. **Reconciliation extension** — Per §40.4.3: §14.8 statement matching can match on `booking_line_items.supplier_booking_ref`. Implement match path.
12. **Tier gating** — Per §40.8: BYO Research excluded; standalone trip-only bookings deferred for ALL tiers (no implementation in v1).

## Required tests

- Each item_type accepts its corresponding JSONB shape; mismatched shapes rejected by application-side validation
- Commission fields: commissionable=false + rate set → warn or clear rate (UX choice)
- expected_commission_cents = customer_cost_cents × commission_rate, with §14.0 rounding
- Commission rollup query returns correct sum for booking with cruise + 2 commissionable line items + 1 non-commissionable
- Cruise-line-supplied excursion (is_cruise_line_supplied=true) tracked but received_commission_cents may stay 0 (host pays aggregate to cruise)
- Third-party flight statement reconciles via supplier_booking_ref match
- Fuzzy match fallback per §34.5.4 pattern works on line items too
- Cancellation: cruise booking cancelled → prompt for each line item; cancel sets status='cancelled' + cancellation_reason
- §36.7 "Lost Revenue" report includes lost expected commission from cancelled commissionable line items
- Round-trip flight as single line item with return_* fields: end-to-end works
- Round-trip flight as two line items: both link to same booking, both track independently
- Itinerary renders flights in correct position (outbound at start, return at end); excursions on correct port day; insurance only on resources page
- BYO Research tenant: Trip Components section not available (UI gates)
- Bulk Components view filters correctly across bookings; RLS enforces tenant isolation
- Audit log per line item edit

## Hand-off to other sections

- §39 itinerary renderer needs to consume booking_line_items and interleave with cruise itinerary days based on dates. Coordinate at build time.
- §34 import pipeline needs to detect flight/hotel/transfer confirmation emails and route to line-item creation flow.
- §36.7 cancellations report SQL must include line item commission lost expected when calculating measures.

## Open items deferred at build time

- Standalone trip-only bookings (no cruise) — all tiers, v1 (would need a new booking type; out of scope)
- Supplier name normalization (free text in v1; canonicalized table is a future addendum)
- JSONB indexing for hot dimensions (promote to columns if/when needed)
- Per-supplier statement parsing (Viator, Booking.com, Expedia) — future addendum
- Line item clawback fields (revisit if frequency increases)

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: schema applied, type-adaptive UI forms, commission rollup query functional, AI-assisted extraction integrated with §34, bulk Components view live, itinerary integration coordinated with §39, cancellation handling per item, statement reconciliation extended, and tier gating applied. Note deferred items.
