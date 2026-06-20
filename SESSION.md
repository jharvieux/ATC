# Session state — last updated 2026-06-20 TZ

## Just completed
- PR #1285 (merged): One-click release workflow — `release.yml` `workflow_dispatch` that owns the full pipeline (CI, staging block, prod deploy with approval gate, git tag, GitHub Release with auto-generated notes, merge-back to dev). Deploy.yml modified to add `gh release create --generate-notes` step.
- Issue #1286 opened: Add TEST_E2E_OWNER_EMAIL and TEST_E2E_OWNER_PASSWORD to GitHub Actions secrets (blocks `authedPage` Playwright tests in CI)

## In flight
- Nothing in flight — clean checkpoint

## Next step
- User adds `TEST_E2E_OWNER_EMAIL` and `TEST_E2E_OWNER_PASSWORD` to GitHub repo secrets (Settings → Secrets → Actions) — see issue #1286
- After secrets are added, verify `Playwright (Tier 1 + 2 + 2.5)` passes on next CI run
- Next implementable engineering issue after #709 partial — check issue list for unblocked items

## Blocked on user
- `TEST_E2E_OWNER_EMAIL` and `TEST_E2E_OWNER_PASSWORD` need to be added to GitHub repo secrets (issue #1286)
- Issue #1259: attorney sign-off on §15.14.6 wording required before implementation
- Issue #1159: needs beta deployment URL + Stripe test credentials in CI + OAuth sign-up scripting (infrastructure gap)
- Issue #1162: blocked on sub-issues #1257, #1258, #1259, #1260 — all still open

## Open questions
- #709 remaining 23 fixmes: email-connection (#429 Gmail OAuth not provisioned), customer-portal (routes not built), booking (#424 handlers still 501), onboarding (#441 complex flow), agent-chat (needs live endpoint), agent-discovery (needs live agent slugs), auth (OAuth-only sign-in, no form), help (needs help module UI wiring)
- After all blocked issues, what's next in the backlog? May need user to re-prioritize.
