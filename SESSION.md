# Session state — last updated 2026-06-03 22:25 PST

## Just completed
- Merged PR #635 (Travel News ticker — RSS cron, LLM scorer, admin console, public API)
- Merged PR #636 (docs: Opus-vs-Sonnet threshold for first-run audit agents → CLAUDE.md + MEMORY D-147)

## In flight
- **Overnight UX redesign initiative.** 5 sequential PRs, one phase each, in order:
  1. **Phase 1 — Logo system** (Sonnet). Logo + LogoMark components, theme-aware reverse for dark, favicons, drop into landing/auth/admin shells.
  2. **Phase 2 — Post-login routing dispatcher** (Sonnet). End-customer → /chat, tenant agent → tenant home, platform admin → /admin, onboarding-incomplete → next step. Currently EVERY user type lands blank post-login.
  3. **Phase 3 — Landing pages + hamburger menu + Login CTA** (Sonnet). POC-style header on both platform domain AND tenant subdomain. This is the visible fix for "landing only has a logo, nothing to do."
  4. **Phase 4 — Admin collapsible left sidebar** (Opus). Refactor (admin)/layout.tsx to left-side shell, sections collapsible, state persisted per admin.
  5. **Phase 5 — Chat redesign to POC** (Opus). Find-an-agent flow, agent bio cards with photos scraped from POC, map onto existing personas.

### Phase 1 status: starting
- Branch: feature/logo-system (about to create)
- Logos: specs/Logos/ (logo-horizontal.svg, logo-horizontal-reverse.svg, logo-mark.svg, logo-mark-reverse.svg)

## Resolved with user before going dark
- Agent → persona mapping: 1:1 match (no new personas)
- Photo source: scrape live POC https://ai-travel-concierge-tawny.vercel.app
- Admin sidebar grouping: my call, surface in PR for revision
- PR cadence: sequential, one merged before the next starts
- Stop conditions: continue on reversible decisions w/ note; stop on auth/permission ambiguity, spec conflicts, destructive DB work

## Next step
- Create feature/logo-system branch
- Build apps/main/src/components/brand/{Logo,LogoMark}.tsx
- Copy SVGs into apps/main/public/brand/
- Wire favicons (favicon.ico + apple-icon.png from logo-mark, light + dark variants)
- Drop logos into existing landing (app/page.tsx), auth pages, admin layout
- pnpm verify + browser smoke test + PR

## Blocked on user
- Nothing — user authorized overnight run

## Open questions
- POC fetch reliability (Phase 5) — if site is down at scrape time, will use initials placeholder
</content>
</invoke>