# Session state — last updated 2026-06-08

## Just completed
- **#887 — descriptive lightbox labels + mobile-safe modal (deployed).** Per operator feedback on #884: (1) the deck-plan link now reads e.g. "Norwegian Bliss Deck 17" (derived from the asset caption via `assetLinkLabel`, full caption as modal title) instead of "View deck plan"; (2) mobile modal fixed — the shared `components/ui/dialog.tsx` panel is now `max-h-[90vh] overflow-y-auto` (+ wrapper `p-4`) so it never overflows and the ✕ stays reachable, and the lightbox image is capped at `max-h-[75vh] max-w-full` to scale to fit. MEMORY D-190. atc-main deployed (dpl em5m1b5uu).
- Earlier this session (all live): #884 on-page lightbox (replaced new-tab hyperlink, D-189), #882 display-asset SSE wiring (markers finally render), #880 AI-cost-gate exemption for `is_platform_internal` (fixed "AI temporarily unavailable" on Booking), #868 retrieval stack (ship_lookup/port_lookup + conversation-context entity extraction).

## In flight
- Nothing in flight — clean checkpoint. dev = 22745ae9.

## Next step
- **Browser-verify #887 in prod, especially on mobile:** ask Bliss → "send the deck plan" → confirm links read "Norwegian Bliss Deck N", clicking opens an on-page modal whose image fits/scrolls, and the ✕ is reachable and dismisses it.

## Blocked on user
- Confirm the mobile modal + descriptive labels look right in the browser (only the user can see live UI).

## Open questions / follow-ups
- **#885** — Playwright test for the lightbox open state (image loads on click, Esc/backdrop closes). Repo has no jsdom for the dialog/streaming components; closed-state + panel-cap + modal-body are unit-tested, open-state interaction is browser-verified only.
- **#881** — `CustomerContextChatPanel.tsx` (booking-flow / quote / itinerary embeddable panel) still renders content raw with no `renderMessageContent` — display-asset markers show literally there. Not yet scheduled.
- "AI temporarily unavailable" was the Booking tenant hitting the AI hard-cost gate; #880 exempts `is_platform_internal` tenants. Watch for recurrence on other internal tenants.

## Notes
- MEMORY D-190 says "PR (TBD)" — that's PR #887; left as-is because MEMORY entries are append-only (can't edit a prior entry without explicit permission).
- A transient GitHub 502 during the #884 merge left a stuck "merge in progress" lock for ~3 min earlier; resolved on retry, nothing lost.
