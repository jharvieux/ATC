# Session state — last updated 2026-06-27 10:30 CT

## Just completed
**ATC engineering (merged to `dev`, prod-apply gated):**
- #1482/#1483 DB perf migrations (auth_rls_initplan wrap; 124 FK covering indexes) — **not applied to prod**.
- #1489 stale RLS snapshot catch-up; #1492 snapshot-diff hardening (check:policy-snapshot guard + CLAUDE.md + post-merge drift→issue backstop).

**Audit-service venture (separate business; docs in `docs/audit-service/`):**
- 9-module spec (M1–M9): go-no-go, audit-modules, scan-extras, quality-extras, report-skeleton, test-targets.
- **EPIC #1527** — master tracker with full tooling inventory.
- Built 4 M9 static detectors: `check:server-only` (#1522), `check:fetch-waterfalls` / `check:dynamic-rendering` / `check:client-data-leak` (#1526). All dev-only, audit-mode, tested.
- **Dogfooded the full audit on ATC.** Real findings → ATC issues **#1523** (3 SECURITY DEFINER RPC-exposed + leaked-password) and **#1524** (43 lib modules lack `server-only`). M3 via vitals (health 6.3/10), M4 jscpd (465 clones/5.8%), M5 knip (62 unused exports), M8 Stryker (survived mutant in commission state machine), M9 detectors (8 waterfalls / 27 dynamic pages / 0 leaks).
- Discovered most codebase-health tooling already exists (vitals, knip, Stryker, jscpd, Supabase advisors) → run-not-build.

## In flight
- Nothing — clean checkpoint. (Background Stryker sample finished.)

## Next step
- Venture: validate demand (3 free audits #1511) before more building. Or build M2 pen-test (#1505).

## Blocked on user
- **Prod apply of #1482/#1483** (no-prod-deploys rule).
- **#1524 server-only remediation needs the `server-only` runtime dependency** — needs owner approval to add (then apply imports + flip detector to blocking).
- **#1523** SECURITY DEFINER hardening — operator/DB-gated; revoking EXECUTE may break RLS, test first.

## Open questions
- Surface the ATC quality findings (knip dead exports, jscpd clones, the Stryker survived mutant) as individual ATC issues? Currently captured in EPIC #1527 only.
- #1484 (drop 86 unused indexes) still open — per-index review + prod-gated.
