# Session state — last updated 2026-05-24 ~19:30 UTC

## Just completed (this session)

Massive session. Two epics shipped + cascade-merged a backlog of 8 PRs.

### Pre-go-live hygiene + foundational refactors (8 PRs merged into dev)

- PR #103 — E2E tier 1+2+2.5 plumbing + 17 specs + bug-intent + asset renderer + CI workflow (incl. PostgREST v12 → v14 install fix)
- PR #104 — RLS snapshot tooling extended to cover rag DB
- PR #105 — BP22 platform-admin-configurable retrieval composite weights
- PR #106 — BP38 `@atc/contracts` zod package (single source of truth for main↔rag)
- PR #107 — BP24 streaming foundation (`instrumentedClaudeStream` + `bufferToSentences`)
- PR #108 — D-041 platform_settings cross-project sync (sender + receiver + retry + reconcile)
- PR #112 — BP24 chat-route streaming wiring (option B UX, `delta_start`/`rewriting`/`message_revised` events)
- PR #113 — BP24 help-AI streaming wiring (`[REWRITE]` sentinel)
- PR #114 — chat-route stale streaming comment refresh

### Pre-go-live no-cost items

- PR #115 — RS256 service JWT signer + 2 tenant-scoped wire-ups *(open, blocked by Vercel rate limit)*
- PR #116 — rag-service-count cron wire-up (stacked on #115) *(open)*
- PR #117 — Migrate 4 TODO(platform-alert) sites to `sendOperatorAlert` *(open)*

### Payment gate epic — 4 stacked PRs

- PR #118 — `tenants.subscription_status` + `non_paying_since` + Stripe webhook wires + `derivePaymentState` helper + 21 tests
- PR #119 — Middleware redirect past 7-day grace + persistent banner (stacked on #118)
- PR #120 — `excludeNonPayingPastGrace` cron helper + 5 bulk crons migrated + 9 tests (stacked on #119)
- PR #121 — `InactivityReminder` email + `compliance-nightly` rewire; **180d auto-suspend removed for paying tenants** (stacked on #120)

### Policy changes captured

- Paying-but-inactive tenants no longer auto-suspend at 180d. Suspension follows non-payment only (via the middleware gate). Captured in PR #121's description and reflected in the `compliance-nightly` rewrite.

## In flight

- Nothing committed in flight on a working branch. All work is in open PRs above.

## Next step

1. **Work the JWT cross-tenant follow-up** (#115's flagged design question). Recommended hybrid: seed PLATFORM sentinel tenant in `tenant_registry_shadow`, switch genuinely-cross-tenant callers to use it; tenant-scoped callers (post-termination, rag-tenant-scoped-purge) use the affected tenant's id. Wires the remaining 6 admin/cron sites that PR #115 didn't touch.
2. **Event-driven cron migration** — add `assertTenantStillPaying` (from PR #120's helper) to the per-tenant Inngest handlers that aren't bulk loops: `precruise-generate-and-send`, `tenant-on-terminated`, `group-reminder-cadence`, etc.
3. When Vercel quota clears: merge cascade for the 11 open PRs (#115 → #116 → #117 → #118 → #119 → #120 → #121).

## Blocked on user

- **Vercel build quota** — required check `Vercel – atc-main` failing with `Deployment rate limited — retry in 24 hours`. Blocks merges of #115/116/117/118/119/120/121. Options: (A) Vercel Pro upgrade, (B) wait ~24h, (C) temporarily remove `Vercel – atc-main` from required checks in repo settings.
- **`OPERATOR_SLACK_WEBHOOK_URL` env var** — must be set for PR #117's alerts to surface beyond `audit_log`.
- **`SUPABASE_RAG_TEST_DB_URL` GH secret** — needed for PR #104's rag CI drift check.
- **Migrations to run when promoting**: `20260613000000_retrieval_weights.sql`, `20260614000000_platform_settings_sync.sql`, `20260615000000_tenant_payment_state.sql` (main) + `0014_composite_weights.sql`, `0014_platform_settings_sync.sql` (rag).
- **JWT design decision** — three options for the cross-tenant admin JWT path were laid out in PR #115's description; the recommended hybrid (A + C) is what the next session would default to absent further direction.

## Open questions

### #6 from the original pre-go-live list — auto-downgrade for paying inactive tenants

Resolved as: **don't do auto-downgrade**. User confirmed: "For inactive paying subscribers there shouldn't be an auto-downgrade but friendly reminder email." PR #121 implements that. The original D-049 deferral is effectively closed; if you want a MEMORY entry capturing the resolution, that's worth doing.

### Carried forward from earlier sessions (not addressed this session)

- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
