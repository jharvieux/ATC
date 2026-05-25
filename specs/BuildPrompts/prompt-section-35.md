# Build Prompt — Section 35: Referral Source Attribution

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves middleware modifications, a rolling-window trigger, and immutability semantics on first-touch fields — areas where Opus's reasoning depth materially reduces correctness risk. Do not start with Sonnet, Haiku, or any non-Opus model. If you are currently on a different model, stop and switch before proceeding.

---

## What you're building

Referral source attribution capture and storage across the platform. Three storage locations: first-touch immutable columns on `contacts`, conversion-touch immutable columns on `quotes` and `bookings`, and a rolling-10-touch table per contact maintained by a trigger.

## Primary spec reference

`section-35-addendum-referral-attribution.html` — full specification with schema, trigger logic, channel normalization map, and edit semantics.

## Cross-references — read before starting

- `section-01-platform-overview.html` — tenant-resolution middleware (where UTM extraction attaches)
- `section-05-database-schema-main-app.html` — base contacts/quotes/bookings tables this addendum extends; RLS policy patterns in §5.1
- `section-12-crm.html` — contact lifecycle and source field
- `section-17-authentication-signup-consent.html` — consent flow affects whether attribution can be captured
- `section-25-data-privacy-retention.html` — deletion rules for cascading attribution data
- `section-26-security.html` — audit_log patterns for source edits
- `section-34-addendum-inbound-import.html` — imported contacts create touch rows with `source_origin='imported'`
- `section-36-addendum-source-of-business-reporting.html` — consumer of this attribution data

## Build order

1. **Schema** — All migrations per §35.3 (contact columns), §35.4.1 (`attribution_touches` table), §35.6 (quote/booking conversion columns), §35.7.1 (`tenant_attribution_categories`). RLS on all new tables per §5.1.
2. **Middleware UTM extraction** — Hook into existing HTTP middleware; parse five UTM params + referrer + landing path; store in session cookie as `attribution_pending`. Last-write-wins within a session.
3. **Contact identification handlers** — At signup, chat start, form submission — read `attribution_pending` from session, insert `attribution_touches` row, populate `contact.first_touch_*` IFF new contact.
4. **Returning visitor flow** — Identified user with new UTM produces a touch row but does NOT modify `first_touch_*`.
5. **Trigger function** — `attribution_touches_trim_to_ten()` with ORDER BY occurred_at DESC, created_at DESC tiebreaker per §35.4.2. Verify AFTER INSERT FOR EACH ROW semantics produce exactly one DELETE per INSERT in steady state.
6. **Channel normalization** — Map utm_medium → channel per §35.5 table. Apply at insert time (channel stored, not derived live). Map version-id storage deferred per §35.10 — store map version as a config constant for v1.
7. **Manual entry UI** — Source-required at contact creation per §35.7.1. Tenant category list editable in settings.
8. **Edit-source action** — Contact edit creates `agent_edit` touch (uses a slot, audit_log entry). Quote/booking edit updates in place + audit_log; no separate touch since quotes/bookings don't have a rolling table.
9. **Quote/Booking creation handler** — Read most recent `attribution_touches` row for the contact and copy to `conversion_touch_*` columns. Fallback to `first_touch_*` if no touch rows exist (legacy contacts).
10. **Quote-to-booking handoff** — Booking reads fresh from contact's most recent touch, NOT from the quote's conversion_touch. Per §35.6.2.
11. **First-touch correction (platform-admin only)** — Direct DB edit with required audit_log entry. No tenant UI.
12. **Tier gating** — Per §35.9 matrix. BYO Research can set but not edit; all other paid tiers full functionality.
13. **Consent handling** — Per §17, refused consent suppresses attribution capture; treat as direct-visit / no source.

## Required tests

- UTM-bearing first visit, then contact signup → contact's `first_touch_*` populated AND one `attribution_touches` row
- Returning user with NEW UTM → new touch row inserted; `first_touch_*` on contact UNCHANGED
- Insert 11 touches for a contact → exactly 10 remain after trigger; the oldest (by occurred_at, then created_at) was deleted
- Two touches with same occurred_at — eviction uses created_at as tiebreaker correctly
- Agent edits source on contact → new `agent_edit` touch row created; `first_touch_*` unchanged
- 11 agent edits on the same contact → oldest evicted (proves edits consume slots same as other touches)
- Quote created → `conversion_touch_*` populated from most recent touch
- Booking created from same contact 30 days later, after another UTM-bearing visit → `conversion_touch_*` reflects the LATER touch, not the quote's earlier touch
- Imported contact (per §34) → touch row with `source_origin='imported'`; `first_touch_*` populated with import metadata; channel='offline' unless overridden
- Contact deleted → all `attribution_touches` rows for that contact cascade-deleted
- Quote/booking attribution survives contact deletion (no cascade — financial records retained per §25)
- Cross-tenant RLS: tenant A cannot read tenant B's `attribution_touches` even when both use same `utm_campaign` string
- Channel map: utm_medium='cpc' → channel='search'; utm_medium='ppc' → channel='search'; utm_medium=NULL → channel='direct'; utm_medium='something_unknown' → channel='other'
- BYO Research tenant: cannot edit source after contact creation (UI gates)

## Hand-off to other sections

- §36 builds the `attribution_rollup` materialized view ON TOP OF this addendum's columns. Verify the `first_touch_*` columns are populated before §36 build kicks off.
- §17 consent flow needs the attribution_pending suppression hook — coordinate.

## Open items deferred at build time

- Channel map versioning storage (use config constant for v1; promote to table later if map churns)
- Multi-touch attribution models (linear, time-decay) — data is available in the rolling 10, but no calculation in v1
- UTM-spoofing mitigation — flagged but no action in v1

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: middleware UTM extraction live, contact first-touch immutability enforced, rolling 10-touch trigger verified, channel normalization mapping in place, conversion-touch columns populated on quote/booking creation, and tier gating applied. Note any deferred items.
