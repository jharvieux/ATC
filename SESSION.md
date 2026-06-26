# Session state — last updated 2026-06-26 UTC

## Just completed

Five user-reported bugs across two areas (D-302, D-303, D-304):

- **Chat "responding" indicator** (D-302, PR #1471 merged) — thinking bubble hidden during pre-first-token wait; fixed. **Needs main-app deploy to be live.**
- **Group sailing dropdown empty** (D-303, PR #1474 merged, issue #1472 closed) — backfilled `cruise_sailings` from RAG (0→20,901 / 227 ships, port calls 0→98,835). **Live now (data).**
- **Add-invitee `internal_error`** (D-304, PR #1475 merged) — invite insert was missing the NOT NULL `token`; fixed. **Needs main-app deploy.**
- **Forum tab 404** (D-304, PR #1475) — group-create now creates the `forums` row; **2 existing groups backfilled (live now)** so the current group's Forum tab works against the deployed app. Self-heal/lazy-create deferred to issue #1476.
- **No email sent app-wide** (D-304, PR #1475) — root cause: Resend apex domain `ai-travelconcierge.com` is UNVERIFIED (probe = 403; `email_log`=0). Verified sender is `email.ai-travelconcierge.com` (user re-added it; probe send = 200, user received it). Repointed all 5 hardcoded platform senders apex→subdomain. **Needs main-app deploy** — until then the running app still sends from the unverified apex.

## In flight

Nothing in flight — clean checkpoint. Doc PR pending for D-304 MEMORY/INDEX + this SESSION (see Next step).

## Next step

Land the `docs/d304-group-email-fixes` doc PR (MEMORY D-304 + INDEX + SESSION) into dev. Then the work is blocked on the operator deploy.

## Blocked on user / operator

- **Main-app prod deploy (operator-owned):** makes live the chat indicator (D-302) + invitee-token + forum-auto-create + email-domain (D-304) fixes, plus the still-pending D-300/D-301 chat changes and migration 20260712000000 (#1437). **Email will not work in the app until this deploys** (the test email that worked went via direct curl, not the app).
- **Confirm after deploy:** add an invitee (should email + no 500), Forum tab (already works for existing groups), and that a real app email send lands (e.g. trigger an invite or wait for the §18.8 daily reminder cron).

## Open questions

- Immediate-send-on-create for invitees? Currently the daily §18.8 reminder cron emails pending invitations (delivered within a day), not instantly. Product decision — not filed as a bug.
- #1476: forum self-heal (lazy-create-on-GET). #1470, #1418, baselined `String(err)` egress sites — pre-existing, deferred.
- Prior MEMORY note claiming the apex was the "verified platform sending domain" is contradicted by D-304 (apex unverified; `email.` subdomain is the verified one). Left as-is (append-only); noted in D-304.
