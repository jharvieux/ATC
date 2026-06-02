# Session state — last updated 2026-06-02 13:40 UTC

## Just completed
- **Merged #572 report-only CSP** (PR #585, 077bb15): static no-nonce `Content-Security-Policy-Report-Only` header + unauthenticated collector `/api/security/csp-report`. Enforce mechanism (nonce vs experimental-SRI) DEFERRED pending observation data + user cost sign-off. See D-135.
- **Merged nightly-red fix** (PR #586, f9b0448): `rls.test.ts` §12.2 matcher now asserts `err.code === "23505"` (was regexing `String(err)`, which never matches a postgres.js SQLSTATE). This is the real root cause of #576 + #532 — NOT schema drift as the prior session guessed. Determined from `postgres@3.4.9` source without needing test-DB access. See D-137.
- **Investigated #455 → UNBUILDABLE as written**: spec (§9.1/§9.5) models personas by slug; there is no `personas` table to FK against. Surfaced for a user decision; task #52 reset to pending/blocked. See D-136.
- Logged D-135 / D-136 / D-137 in MEMORY.md. Created the `auto-triaged` GitHub label.

## In flight
- Nothing in flight — clean checkpoint. On `dev` at f9b0448; both feature branches (`feature/csp-report-only`, `fix/rls-test-sqlstate-matcher`) merged and deleted.
- Pre-existing untracked/modified noise left alone per standing constraints: `apps/main/supabase/config.toml` (untracked), `.claude/scheduled_tasks.lock` (modified). Do NOT stage or delete.

## Next step
- **No autonomous engineering work remains** — every open item needs a user decision or an external action. When you return, route the items under "Blocked on user."

## Blocked on user
- **Item A / #56** — apply the 5 DB-security migrations to prod. SQL is at `/tmp/apply-security-advisors-main-prod.sql`. The Supabase MCP is read-only, so I cannot apply it; run it via the Supabase SQL editor or psql, then tell me and I'll re-run `get_advisors` to confirm. Out-of-band too: leaked-password protection (dashboard toggle) + vector-extension move (RAG, deferred).
- **#546 / #59** (grant-drift CI) — blocked by Item A; the baseline grant snapshot needs the post-#545 prod grants to be live first.
- **#455 / #52** — decide: (A) close won't-fix (no personas table by design); (B) spec-coherent `active_persona_id UUID → active_persona_slug TEXT` (multi-file change, not a one-file migration); or (C) drop the unused column. Cannot proceed without your call.
- **#563 + #562 / #45** — scope (Phase 1 unauth page-route probe vs Phase 2 seeded fixtures) + infra (seeded 2-tenant test project, CI secrets, preview-URL wiring). Deferred for a morning decision.
- **#514 / #47** — time-gated: removing the unsigned-cookie path is safe no earlier than ~2026-06-30 (30 days after signed cookies deployed 2026-05-31). The `TODO(#514)` marker is compliant — leave it.
- **Issue closes** — #572, #576, #532 are still OPEN (PRs used "Refs", not "Closes"). #576/#532 should auto-resolve when the next nightly goes green. Closing any of these needs your explicit permission.
- **MODEL** — still on Opus. Switch back to Sonnet with `/model claude-sonnet-4-6` (I can't do this autonomously).

## Open questions
- **Next nightly** is the true confirmation that PR #586 fixed #576/#532 — the integration suite is `describe.skip` without DB env, so it could not be run locally. If the next nightly is still red on §12.2, re-open the investigation (but schema at `contact_relationships.sql:20` + `postgres@3.4.9` source both say the matcher fix is correct).
- **#386 / #384** — moving the nightly DB-backed suites off the prod-serving `atc-main` DB, and the broader "false-confidence test" backlog, both need infra/scoping decisions before they're engineering-ready. The #586 fix is one instance of the #384 theme.
- **#455** — is `active_persona_id` meant to exist at all? The spec uses `persona_slug` everywhere; the UUID column looks speculative.
- DAST tier-2 install still DEFERRED. All DAST local/staging only, never prod.
