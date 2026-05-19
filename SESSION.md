# Session state — last updated 2026-05-18 TZ

## Just completed

- Day 0 CI/CD hardening (PR #18 merged to dev):
  - S-1: staging-fixups.sql updated for v6.1 schema
  - CR-1: release/\* branch protection enabled (manual, GitHub UI)
  - CR-3a: .github/CODEOWNERS created
  - HI-6: backup production approver added (manual, GitHub UI)
  - ME-15: all 12 GitHub labels pre-created

## In flight

- Nothing in flight — clean checkpoint

## Next step

- Week 1 Critical hardening, in order:
  1. CR-2 — Hostname guard before destructive DB operations (Opus design → Sonnet implementation)
  2. CR-3 Part B — Dedicated migration role (Opus design → Sonnet implementation)
  3. CR-4 — Auto-merge-back-to-dev enforcement (Sonnet)
  4. CR-5 — Staging Vercel target clarification (manual confirm + Sonnet)
  5. CR-6 — Post-restore sanity check (Sonnet)

## Blocked on user

- STRIPE_TEST_SECRET_KEY repo secret — still needed for contracts-canary nightly re-record
- CR-5 requires operator to confirm Vercel staging domain alias config before prompt runs

## Open questions

- email_connections table status in v6.1 schema is unresolved — defensive block in staging-fixups.sql raises NOTICE if absent; needs verification against actual production schema when it exists
- CODEOWNERS backup reviewer is currently only @jharvieux — add a second person when available
- Screenshot placeholders in rollback runbooks need real screenshots once production is deployed
- §12 eval harness implementation deferred until src/prompts/ and src/tools/ exist
