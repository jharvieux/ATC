# Session state — last updated 2026-06-17 (Stryker sweep + Vercel preview diagnosis)

## Just completed

- **Stryker mutation sweep** (679 files / 52,152 mutants, 27.85% overall). Tooling fixes (ignorePatterns sandbox-copy crash, vitest.stryker.config.ts introspection-test exclude, mutate:thorough flag) + runbook shipped in **#1220 (merged)**. Triage filed: epic **#1219** + issues **#1211–#1218** + cron data comment on #1204. perTest artifact confirmed (permission-grants 6%→83% thorough). See D-260.
- **Vercel "preview builds" investigation** → root-caused to our own middleware, not Vercel. Preview URLs 404 with "This site is not currently active" because `proxy.ts` resolves tenant by hostname and 404s `*.vercel.app`. Fix shipped in **#1221 (merged)**: `proxy.ts` step 5 maps non-prod preview hosts to `PLATFORM_DEFAULT_TENANT_ID` via new `getTenantById()`; 5 tests; both Opus audits clean. See D-261.
- Empirically verified the merged fix still 404s on previews → runtime config gap. Opened **#1222** (ops: set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview scope).

## In flight

- This doc-only PR (D-261 + SESSION) on branch `chore/session-d261` — pending push + merge.

## Next step

- Merge the doc-only PR.
- **User/ops action (#1222):** set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview env scope (= Booking tenant UUID) and confirm that tenant exists in the preview DB, then re-open a PR preview to confirm it renders.

## Blocked on user

- #1222 is an infra/config step in the user's lane (Vercel env var). Code side is done + merged.

## Open questions

- Whether to relax Vercel Deployment Protection for external preview viewers — user chose to KEEP it on (team-only). Revisit only if external stakeholders need preview access.
- Mutation test-writing for #1211–#1218 (not started; security/money first).
- Pre-existing: `check:duplication` ~6% (non-gating); cross-tenant-rls-bypass-monitor fail-open read (#1205 to file).
