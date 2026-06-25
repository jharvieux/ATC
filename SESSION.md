# Session state — last updated 2026-06-24 22:35 PT

## Just completed
- **EPIC #1393 COMPLETE** — all 6 shift-left guards shipped (G1–G6). This session shipped the last 3:
  - PR #1407 (G3): `counter-rmw` detector added to `check:d091` — flags non-atomic read-modify-write on counter/financial fields. 7 sites baselined.
  - PR #1409 (G4): `scripts/check-inmemory-rate-limit.ts` (`check:rate-limit-store`) — flags module-level Map/Set rate limiters. 2 baselined.
  - PR #1411 (G6): `scripts/check-webhook-replay.ts` (`check:webhook-replay`) — flags inbound-signature webhook handlers with no replay defense. 1 baselined (feedback).
- All wired into `pnpm verify` + `ci.yml`; CLAUDE.md doctrine #18/#19/#20 added.
- Filed #1408 (pre-existing `detectServiceRoleTenant` false-negative: `.select(...tenant_id...)` masks a missing `.eq("tenant_id")` filter — surfaced by G3 audit).
- Closed #1410 not-a-bug (tenant-events/platform-settings-events `source_revision >= incoming` guard DOES defeat replay; my filing premise was wrong).
- MEMORY D-297 added.

## In flight
- Nothing committed in flight. NOTE: `MEMORY.md`, `MEMORY-INDEX.md`, `SESSION.md` are edited locally on `dev` but NOT yet committed — these need a docs PR (branch protection: no direct commits to dev). Doc-only PR → fast checks, no audit agents.

## Next step
- Open a `docs/*` branch with the MEMORY.md + MEMORY-INDEX.md + SESSION.md updates, PR into dev, merge once fast checks settle. (Was about to do this at session end.)
- Then: the per-finding security fixes remain open (the guards prevent NEW instances; existing baselined debt still needs fixing): F-ssrf-01 #1381, F-rag-pii-02 #1383, F-rag-wh-02 #1385, F-tok-01 #1386, F-inp-02 #1387, F-sm-01/02/03 #1376/#1377/#1378, F-rag-pii-01 #1388, plus #1395 (G1 baseline burn-down), #1408, #1410-sibling feedback fix.

## Blocked on user
- **2 open code-scanning alerts (medium, shipped code):** `js/log-injection` at `apps/main/src/app/api/chat/route.ts:242` (#92) and `apps/main/src/lib/auth/respond.ts:99` (#91). User-provided value into a log entry. Surfaced at session start as "needs your call" — not yet routed (fold into a fix PR vs. dismiss-if-acceptable). Still open.
- #1365: operator bump Supabase refresh_token_reuse_interval 10s→30s (prod dashboard)
- F-sm-01 #1376 / F-sm-02 #1377: SQL migrations → prod-gated
- F-auth-01 #1379: OTP/identity-binding product decision
- #1391: robust F-pay-01 idempotency key (migration → prod-gated)

## Open questions
- Playwright E2E still failing in CI (missing TEST_E2E_OWNER_* secrets, #1286) — non-required, not caused by our changes.
