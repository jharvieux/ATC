# Spec gap analysis — supplement to reality-delta.md

Findings from a systematic sweep of `specs/TechSpec/section-*.html` against current `dev` branch state (2026-05-25). Entries here are **gaps NOT already documented in `reality-delta.md`**.

The same usage rules apply: each entry tells you what to add to the spec OR what to build. `MEMORY D-NNN` refs cite decision history when relevant.

---

## Critical-path gaps (likely launch-blocking or audit-exposed)

### ~~§14.11 — 1099-NEC reporting~~ (NOT a gap — Stripe Connect handles it)
- **Spec quote (§14.11 in full):** "Stripe Connect Express handles 1099-NEC generation for sub-hosts ≥ $600/year. Platform's only responsibility: ensure all payouts flow through Connect (no off-platform payments). Stripe files with IRS and provides sub-host's copy via Connect dashboard."
- **Current state:** All payouts flow through Stripe Connect via `inngest/payouts-execute-transfer.ts` ✓. No platform-side 1099 code is needed or expected.
- **Original entry (incorrect):** Initial scan flagged this as a missing-code gap. The §14.11 text explicitly delegates issuance to Stripe Connect Express; nothing is missing.
- **Action:** None. Entry retained for paper trail.

### §32.3 — Tenant Admin Console Documentation (10 of 12 docs missing)
- **Spec:** 12 help-doc markdown files at `apps/main/content/help/`:
  - 01-getting-started.md ✓
  - 02-tenant-settings.md ✗
  - 03-branding.md ✗
  - 04-personas.md ✗
  - 05-crm.md ✗
  - 06-quotes-and-bookings.md ✗
  - 07-rag-content.md ✗
  - 08-usage-and-billing.md ✗
  - 09-team-and-permissions.md ✗
  - 10-customer-management.md ✗
  - 11-supervisor-and-quality.md ✗
  - 12-troubleshooting.md ✓
- **Current state:** 2 of 12 files exist, both thin (~50 lines each). The PDF/Word export pipeline (BP31 Phase C) is built but renders almost-empty deliverables.
- **Action:** Write the remaining 10 docs. This is content work, not engineering — but it blocks BP31 Phase C from being useful at launch.

### Tenant-facing settings UI gaps
The data layer + APIs exist, but tenants have **no UI** for:

| Surface | API | UI |
|---|---|---|
| Branding (logo, colors, custom domain) | `/api/tenant/branding`, `/api/admin/tenants/[id]/custom-domain` ✓ | `(tenant)/settings/branding/page.tsx` ✗ |
| Persona overrides + addendum | `/api/tenant/personas` ✓, screening cron ✓ | `(tenant)/settings/personas/page.tsx` ✗ |
| RAG submission review (§22.5) | `/api/rag/queue` ✓ | `(tenant)/crm/rag/queue/page.tsx` ✗ — only admin-side review exists |

These three are major: every Pro+ tenant needs branding + persona control to onboard meaningfully, and RAG-submission review is required before any tenant-submitted content can go global (§22.6).

<!-- §29.14 — DR posture runbook — CLOSED in this PR.
     docs/runbooks/disaster-recovery.md ships with the 9 scenarios from
     the §29.14 matrix, a backup-verification cadence section, and a
     recovery-rehearsal log structure for SOC 2 readiness. -->
### ~~§29.14 — Disaster Recovery Posture~~ (closed: `docs/runbooks/disaster-recovery.md`)

<!-- §30.7 — k6 scripts — CLOSED in this PR.
     tests/load/k6/ ships the 6 scenario scripts (chat-sustained,
     signups-burst, group-invite-blast, rag-retrieval,
     stripe-webhook-flood, multi-tenant-fanout) + a README with run
     instructions and prerequisites. CI does NOT run them per spec —
     they're out-of-band, manual, quarterly. -->
### ~~§30.7 — Load testing (k6 scripts)~~ (closed: `tests/load/k6/`)

---

## Spec-aligned but deferred / incomplete

### §19.10 — Post-sailing forum read-only mode (MISSING)
- **Spec:** Once a group's sailing_date passes, the group's forum transitions to read-only (no new posts, no edits).
- **Current state:** No code matches `post_sailed_mode`, `sailed_at.*forum`, or similar. The `groups-mark-sailed.ts` cron exists and marks groups sailed, but the forum POST route doesn't check that flag.
- **Action:** Add a `groups.sailed_at` check at `/api/forums/[forumId]/threads/[threadId]/messages` (POST) — return 410 Gone if sailed.

### §20.5 — DOB Confirmation Gate (MISSING)
- **Spec:** Booking submission requires the customer to confirm DOB for every passenger before the booking is submitted. The §11.5 "DOBs not ages" policy means we have an actual DOB on file, but the GATE re-prompts the customer at submit-time.
- **Current state:** `bookings/[id]/submit/route.ts` does NOT check any `dob_confirmed_at` field on passengers or contacts. The booking-flow UI may or may not surface the prompt — but the server-side gate is absent.
- **Action:** Add `passenger_dob_confirmed_at` (or similar) column to `booking_passengers`, enforce in submit handler.

### §17.10 — CCPA delete grace cron *(verify)*
- **Spec:** 30-day grace period before CCPA deletion fires; nightly cron processes graduates.
- **Current state:** `inngest/user-data-purge-after-grace.ts` exists. ✓ — but worth double-checking that the cron schedule is daily AND the grace-period math is correct after my recent privacy work. (Stryker survivors on this file's arithmetic suggest test gaps.)
- **Action:** Spot-check the cron's schedule + the grace_period_ended_at calculation against §17.10 exact wording.

### §26.5 — `audit_log` 7-year retention purge (MISSING cron)
- **Spec:** audit_log rows retained 7 years, then hard-deleted.
- **Current state:** Various other purge crons exist (`booking-commission-retention-purge`, `purge-parsed-documents`, `forensics-log-purge-cron`, `rag-rejected-items-purge`, etc.) — but **no `audit-log-retention-purge` cron**.
- **Action:** Add the cron. 7-year boundary: `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '7 years'`. Should also write a meta-audit row "audit_log retention purge ran, N rows deleted".

### §30.6 — AI Evaluation Harness (design-only, not running)
- **Spec:** Claude-as-judge eval harness, regression detection > 5% verdict-change OR any safety-critical flip, contested-verdict review queue, 1% sampling daily, weekly drift trend alerts.
- **Current state:** `docs/evals/design.md` exists. **No CI hook, no harness code, no golden set, no cron**. MEMORY D-024 documented this as deferred.
- **Action:** Already in `reality-delta.md` §1 as cost-deferred. This supplement just confirms the design doc exists but execution is fully deferred.

### §13.9 — Host Adapter Health Monitoring cron (PARTIAL)
- **Spec:** Cron checks every active tenant_host_configs row's credential health, marks status (active / degraded / rejected). Banner surfaces.
- **Current state:** `lib/host-adapters/credential-health.ts` exists with the banner-resolution logic ✓ (I just refactored it to query audit_log). The BANNER is wired. But there is **no cron** that actively probes adapter health — currently health is inferred reactively from decryption failures.
- **Action:** Decide whether reactive-only health is acceptable for launch. If active probing is needed (the spec implies it via "ongoing monitoring"), add `inngest/host-adapter-health-probe.ts` running nightly.

### §28.21 — Local development setup
- **Spec:** Documented `pnpm dev` flow + the env-vars-you-need-locally list.
- **Current state:** `docs/local-development.md` exists ✓ — but worth verifying it matches the .env.example file after BP29's env reconciliation work.
- **Action:** Quick audit of the doc vs. `apps/main/.env.example`.

### §29.5 — Supabase project setup runbook (MISSING)
- **Spec:** A runbook for setting up a fresh Supabase project (extensions to enable, RLS bootstrap, service-role grants, etc.).
- **Current state:** No `docs/runbooks/supabase-setup.md`. We have `local-development.md` which has some of this for local; no production-Supabase setup doc.
- **Action:** Write it. New environments + ops handoff need this.

---

## Smaller gaps worth tracking

### §10.5 — Supervisor Dashboard (UI exists, completeness unclear)
- Page at `apps/main/src/app/(admin)/supervisor/page.tsx` (244 lines). Worth a manual UX review against the §10.5 spec to confirm all dimensions render (sample category counts, regen budget exhaustion, kill-switch state, drift trend chart).
- **Action:** UX review pass; backlog any missing widgets.

### §32.9 — Interactive Bug Triage and Fixing
- `apps/main/src/app/(admin)/admin/help-triage/page.tsx` exists. Phase 2 readiness check at `phase-2-readiness/page.tsx`. **Probably built, worth a UX review** against the §32.9 contract (the "AI suggests fix → operator clicks accept" flow).

### §32.16 — Calls Worth Flagging
- Spec section enumerates known follow-ups for §32. Sweep these against MEMORY D-067/D-068 to verify each has a decision recorded.

### §26.11 — Penetration testing posture
- **Spec:** Annual pentest required pre-SOC 2.
- **Current state:** No runbook documenting how to scope / select firm / handle findings.
- **Action:** Doc-only. Write `docs/runbooks/pentest-scoping.md` before scheduling first engagement.

### §27.13 — Cross-section integration completeness
- **Spec:** Lists the integration points abuse monitoring must touch in §13, §22, §23, §26.
- **Current state:** Most are wired (cost tracking, RAG cap, email rate limit, group invitations). Worth a per-integration spot-check.

### §35 — Referral attribution completeness
- Migration `20260618000000_bp35_referral_attribution.sql` ✓
- Capture mechanism (UTM cookie, middleware) ✓
- Touch-table (`attribution_touches`) ✓
- **§35.4 Rolling Touch Table** — verify the rolling-window cleanup is wired (any cron pruning old touches?).
- **§35.6 Quote/Booking conversion touch fields** — verify both tables have the conversion attribution columns.

### §36 — Source-of-Business reporting
- Migration + routes exist ✓
- **§36.4 Campaigns table** + **§36.6 attribution_rollup materialized view** — verify both exist and the rollup-refresh cron runs.
- **§36.8 Export** — verify CSV export is wired.

### §37 — Tasks and sequences trigger fan-out
- Engine + Inngest job ✓ (covered in `reality-delta.md`)
- Already-known gap: pipeline-transition CRM endpoints don't call `triggerMatchingSequences()` yet. That's the missing piece.

### §38.8 — AI Co-Pilot for quote builder
- Quote builder + multi-option + PDF gen ✓
- **§38.8 AI Co-Pilot** — does the quote builder surface AI suggestions per-option (cabin recommendation, included perks, etc.)? Search for `quote.*suggest\|copilot`.

### §39.5 — Customer-side AI in trip-itinerary deliverable
- Itinerary PDF generator ✓
- **§39.5** — does the customer-facing trip page have an embedded chat for itinerary questions? Search for `itinerary.*chat\|trip.*ai`.

### §40 — Non-cruise line items completeness
- Schema + routes ✓
- **§40.5 UI / Agent Workflow** — the editor mounting was flagged in `reality-delta.md` as needing booking-detail page first. Same blocker applies here.

### §16.5 — Persona Overrides UI (Pro+ tiers)
- `tenant_persona_overrides` table ✓
- `persona_addendums` table ✓ + screening cron ✓
- **MISSING:** tenant-facing UI to author/edit. This is the same as the "tenant-side settings UI gaps" item above; calling it out separately because it's the §16.5 specific surface.

---

## Confirmed present (and likely fine)

For completeness — items I checked that are properly wired:

- §13.6 Fallback email adapter ✓ (`lib/host-adapters/fallback-email/`)
- §18.8 Group reminder cadence cron ✓ (`inngest/group-reminder-cadence.ts`)
- §18.10 Sailed-status cron ✓ (`inngest/groups-mark-sailed.ts`)
- §19.5 Forum reactions migration ✓
- §22.5 Tenant review queue API ✓ (the *tenant UI* is what's missing, see above)
- §23.4 Pre-cruise email Inngest jobs ✓
- §23.5 Companion web pages ✓ (`apps/main/src/app/companion/`)
- §24.11 Memory indicators (chat UI) ✓
- §26.6 Sentry monitoring ✓ (server + client config, PII scrubber)
- §26.10 Breach response runbook ✓ (`docs/runbooks/breach-response.md`)
- §27.10 Admin abuse dashboard ✓ (302 lines)
- §27.11 Tenant usage UI ✓
- §28.20 Secret rotation runbook ✓
- §29.8 Rollback runbooks ✓ (DB + application)
- §29.10 Sentry stack ✓
- §32.9 Bug triage console ✓ (admin-side)
- §33.6 RAG media assets ✓
- §33.8 Price-watch subscriptions ✓
- §35 Attribution capture migration + middleware ✓
- §38.6 Quote PDF generation ✓
- §39 Itinerary deliverable PDF gen ✓
- §40 Non-cruise line-items API ✓

---

## Process notes

Same conventions as `reality-delta.md`:
- This file is **append-only**; do not edit prior entries without explicit approval.
- When a gap is closed, leave the entry with a `> **Closed YYYY-MM-DD in #PR**` callout rather than deleting — preserves history.
- New gaps surfaced after a feature lands belong in this supplement, not in `reality-delta.md` (which is reserved for deviations from the original spec text).
