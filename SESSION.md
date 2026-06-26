# Session state — last updated 2026-06-26 UTC

## Just completed

Bug fixes + two feature requests across the group-booking + chat surfaces (D-302 → D-305):

- **Chat "responding" indicator** (D-302, PR #1471) — fixed. Needs main-app deploy.
- **Sailing dropdown empty** (D-303, PR #1474, #1472 closed) — backfilled `cruise_sailings` from RAG (live now).
- **Add-invitee 500 / Forum 404 / app-wide email dead** (D-304, PR #1475) — token fix + forum auto-create (+ 2 groups backfilled, live) + Resend domain repointed apex→verified `email.` subdomain. Code needs deploy. Forum self-heal follow-up: issue #1476.
- **Immediate invitation emails on group create + coordinator group delete** (D-305, PR #1478) — create now emails invitees immediately (shared `lib/groups/send-invitation-email.ts`); `DELETE /api/groups/[id]` coordinator-only with a "type the sailing date to confirm" guard; danger-zone UI on the Edit tab. Needs deploy.

## In flight

Nothing in flight — clean checkpoint. Doc PR pending for D-305 MEMORY/INDEX + this SESSION (see Next step).

## Next step

Land the `docs/d305-group-features` doc PR into dev. Then everything is blocked on the operator main-app deploy.

## Blocked on user / operator

- **Main-app prod deploy (operator-owned):** makes live ALL of D-302/D-304/D-305 (chat indicator, invitee-token, forum auto-create, email-domain repoint, immediate invites, group delete) + the pending D-300/D-301 chat changes + migration 20260712000000 (#1437). **Email + the new group features do not work in the running app until this deploys.**
- **After deploy, verify:** add an invitee (emails + no 500); create a group with invitees (each gets an immediate email); delete a group (type sailing date to confirm → redirects to /groups); a real in-app email lands from `email.ai-travelconcierge.com`.

## Open questions

- #1476 forum self-heal (lazy-create-on-GET). Pre-existing deferrals: #1470, baselined `String(err)` egress sites.
- Prior MEMORY "apex verified" note is contradicted by D-304 (apex unverified; `email.` subdomain is verified). Left as-is (append-only); noted in D-304.
- d091 helper test (delete-group) stubs safeAwait → error-propagation untested at that layer (non-blocking nit; safeAwait tested elsewhere; not filed).
