# Build Prompt — Section 39: Client-Facing Deliverables (Itinerary & Trip Resources)

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves tokenized public-access endpoints (security-sensitive), PII posture decisions you must NOT relax, RAG integration for port and ship content, and a customer-side AI chat panel with scoped capabilities. Opus's reasoning depth is needed to maintain the PII posture and tokenization correctness. Do not start with Sonnet, Haiku, or any non-Opus model.

---

## What you're building

Two client-facing deliverables for booked customers: a consolidated trip itinerary (web + PDF, tenant-branded) and a trip resources page (curated external links, agent contact, packing checklist). Both tokenized public access, both with embedded AI chat.

**CRITICAL POSTURE: This addendum explicitly REJECTS storing customer PII documents (passport scans, IDs, insurance PDFs). The platform stores links and structured metadata only. Do not introduce file uploads even if it seems convenient. See §39.4.**

## Primary spec reference

`section-39-addendum-client-facing-deliverables.html` — full specification including schemas, public-access endpoint design, PII posture, and customer-side AI scoping.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — base patterns
- `section-09-ai-personas.html` — AI persona scoping (customer-side AI cannot quote new bookings)
- `section-11-customer-memory.html` — context loaded into customer-side AI
- `section-12-crm.html#s12-4` — token-based access pattern for quote-send flow (mirror this)
- `section-13-host-agency-abstraction-layer.html` — branding tokens per tenant
- `section-20-booking-flow.html` — booking states that trigger itinerary generation
- `section-21-rag-knowledge-base-consumer-side.html` — RAG retrieval for port/ship content
- `section-23-email-notifications.html` — itinerary send email
- `section-25-data-privacy-retention.html` — retention horizon for archived itineraries
- `section-26-security.html#s26-3a` — service-role-mediated public endpoints
- `section-26-security.html#s26-5` — audit_log for edits
- `section-27-saas-abuse-monitoring-cost-controls.html` — customer-side AI session budget
- `section-33-addendum-external-data-sources-and-media-assets.html#s33-5` — CruiseMapper port/ship content source
- `section-38-addendum-multi-option-quote-builder.html#s38-5` — line_items source for "What's included"
- `section-40-addendum-non-cruise-line-items.html` — non-cruise items displayed on itinerary

## Build order

1. **Schema** — Per §39.2.5: `trip_itineraries` table. Per §39.3.4: `trip_resources` table. Both with RLS per §5.1. Both with `access_token` and partial indexes filtered by status.
2. **Tokenized public-access endpoint** — `/i/<token>` for itineraries, `/r/<token>` for resources. Server-side token validation, status check, render. No client-side auth required for public access. Audit log entry per view per §39.2.6.
3. **Token rotation** — Agent-initiated rotation invalidates old token immediately.
4. **Itinerary content composition** — Per §39.2.1: cover, at-a-glance, day-by-day (RAG port content), ship overview (RAG), what's-included (line_items), travel doc reminders (generic checklist, NO PII), agent notes, next-steps timeline.
5. **Resources page composition** — Per §39.3.5: auto-populate cruise-line links, port-authority RAG content, travel advisories, packing checklist (template-by-itinerary-type), agent contact. Empty insurance section by default.
6. **PII posture enforcement** — No file upload endpoint on either surface. The temptation to "let customers upload their passport for safekeeping" must be refused. If reviewer/designer raises this, redirect to §39.4 deferral text.
7. **Itinerary PDF generation** — Per §39.6: Puppeteer or react-pdf; multi-page; tenant branding; "ESTIMATE" or appropriate confidence marker per §21.10.
8. **PDF storage and re-generation** — Latest PDF in Supabase storage, key on `trip_itineraries`. Re-send regenerates PDF; old PDF not retained server-side.
9. **Send flow** — Email per §23 with web link + PDF attachment.
10. **Customer-side AI** — Per §39.5: persona from booking's contact; context = booking details + memory + agent notes + RAG enabled. Cannot create bookings, modify booking, expose commission. Per-deliverable session budget cap per §27.
11. **Editing and re-sending** — Save Draft (no notify); Save & Re-send (regenerate PDF, notify). Audit log per edit.
12. **Branding** — Per §39.8: tenant logo, colors, font. White-label theme for sub-hosts.
13. **Lifecycle states** — draft → sent → archived per §39.2.4. Resources page: draft → published → archived per §39.3.4.
14. **Tier gating** — Per §39.9: BYO Research excluded; all paid tiers full.
15. **Integration with §40** — Non-cruise line items appear in appropriate itinerary sections per §40.6.

## Required tests

- Tokenized URL renders correctly without authentication
- Token rotation: old URL returns 404; new URL works
- Draft itinerary URL returns 404 (only sent/archived accessible)
- Audit log captures token, IP, user-agent for each view
- "What's included" derived from booking's line_items; missing line_items shows generic fallback message
- RAG port content loads and renders; if RAG unavailable, port shows name + dates only (graceful degradation)
- PDF generation completes within reasonable time (track p95)
- Re-send regenerates PDF and emails customer
- Customer-side AI persona = booking contact's persona
- Customer-side AI: prompted "create a new booking for me" → declines per persona scoping
- Customer-side AI: prompted for commission info → declines
- Customer-side AI: answers port question correctly using RAG
- Branding: tenant colors and logo present on both web and PDF
- White-label theme on sub-host tenant; no platform branding visible
- Resources page: no file-upload UI present (PII posture check)
- Resources page: links open in new tab; agent contact present; packing checklist by itinerary type
- BYO Research: deliverables not available (no booking flow on that tier)
- Per-session AI cost tracked per tenant per §27
- Audit log on every edit per §26.5

## Hand-off to other sections

- §40 non-cruise line items must surface on the itinerary at correct positions per §40.6. Coordinate.
- §33 RAG content for ports and ships must be available at the time of itinerary rendering. If RAG MV is stale or empty, the itinerary degrades gracefully.

## Open items deferred at build time

- Per-country travel advisory link mapping (US State Department default; international tenants need their equivalents — agent enters URL manually for v1)
- Versioned content storage (audit-log-only for v1)
- Post-trip "memory book" deliverable — not in v1

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: both deliverable surfaces tokenized and rendering, PDF generation working, customer-side AI scoped correctly, branding applied, lifecycle states functional, and — most importantly — the PII posture from §39.4 enforced (no file-upload endpoint present anywhere on either surface). Explicitly confirm this PII posture check.
