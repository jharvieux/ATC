# Session state — last updated 2026-07-01 16:45 UTC

## Just completed
Group cruise invite landing page + coordinator redesign, per `specs/design_handoff_group_landing/`. Decisions locked in with user: roster shows "First L." or "Anonymous" (still counted in aggregates); ship stats/itinerary sourced from RAG via regex backfill (signature_feature stays manual, issue #1565); customer group chat gets its own anonymous token-based posting scheme (not session-auth/viewer-grants); declined invitees get a quiet 4th stat column (diverges from the design file); coordinator page gets a fuller relayout, not just a token swap.

Merged so far:
- **PR #1564**: `cruise_ships` gains nullable `guest_capacity`/`decks`/`built_year`/`signature_feature` columns. Issue #1565 tracks `signature_feature`'s missing curation path.
- **PR #1566**: `scripts/backfill-ship-stats-from-rag.sql` — one-shot idempotent regex backfill from RAG's `knowledge_chunks` (ship_intel category), same shape as D-303's sailing backfill. Not yet run against any DB — dry-run is a manual follow-up.
- **PR #1567**: Fixed a real bug (`buildCabinGrid` was skipping anonymous invitees from aggregate RSVP counts entirely, not just the named list). Extended `GET /api/groups/invite/[token]` with `roster`/`itinerary`/`ship_stats`/`chat_preview`. Went through 3 rounds of d091-reviewer findings (dead param, missing tenant_id filter on forum reads, chat-preview author name bypassing anonymity truncation) — all fixed and confirmed. First-ever request-level test coverage added for this route.

## In flight
- Nothing in flight — clean checkpoint. Branch `feature/group-landing-redesign` (PR1's original branch) is gone; all subsequent work branches were rebased off `dev` directly and merged.

## Next step
Continue the remaining phased plan (see task list, still tracked in this conversation):
- **PR3**: Scoped "Bright & Vacation-y" theme tokens — `[data-cruise-theme]` light/dark CSS var blocks in `globals.css` (mirror the `[data-ta-theme]` precedent), Quicksand via `next/font/google`, independent `CruiseThemeToggle` (own localStorage key, not next-themes), drop unscoped `<TenantTheme/>` color/font usage on the two target route trees (keep only display_name/logo/favicon).
- **PR4**: Customer invite-landing page rewrite (`apps/main/src/app/group/invite/[token]/page.tsx` + new `components/group-invite/` tree) — match design option 1b, quiet 4th "Can't make it" stat column, optimistic RSVP via the existing PATCH endpoint, anonymous-RSVP toggle wired to `visibility_choice`.
- **PR5**: Coordinator page fuller relayout (`groups/[id]/coordinate/[tab]/page.tsx` + tab clients) to the cruise theme.
- **PR6**: Anonymous token-based forum posting — nullable `invitation_id` FK + CHECK on `forum_threads`/`forum_messages`, new public HMAC-token-scoped routes mirroring the RSVP route's auth pattern (not session/viewer-grants), `ForumTabClient.tsx` author-resolution update for guest-authored messages.

## Blocked on user
- Nothing right now — proceeding autonomously per the "do it" go-ahead already given for this whole redesign.

## Open questions
- The RAG ship-stats backfill script (PR #1566) hasn't actually been run/dry-run yet — needs an operator pass against the test DB once convenient, per its own PR description's unchecked test-plan item.
- `signature_feature` curation path (issue #1565) is unresolved — no admin UI built yet, deliberately deferred.
