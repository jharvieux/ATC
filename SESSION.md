# Session state — last updated 2026-06-08

## Just completed
- **#884 — display assets open in an on-page lightbox (deployed).** Per operator: clicking a deck-plan link no longer opens a new tab to cruisemapper.com. Each `[[display_asset:<uuid>]]` marker now renders `<AssetLightbox>` — a trigger + inline attribution that opens the image in a dismissible on-page modal (reuses `components/ui/dialog.tsx`). Still hot-links (not hosts) the image; attribution shown inline + in modal; image loads lazily on open. MEMORY D-189 (partial reversal of D-075). atc-main deployed (dpl bywvkzbdx).
- Earlier this session (all live): #882 display-asset SSE wiring (markers finally render), #880 AI-cost-gate exemption for `is_platform_internal` (fixed "AI temporarily unavailable" on Booking), #868 retrieval stack (ship_lookup/port_lookup + conversation-context entity extraction).

## In flight
- Nothing in flight — clean checkpoint. dev = fd968d3a.

## Next step
- **Browser-verify #884 in prod:** ask Bliss itinerary → "send the deck plan" → click "View deck plan ⤢" → image opens in an on-page modal; Esc / backdrop / ✕ closes it; no new tab. This is the open-state interaction not covered by unit tests.

## Blocked on user
- Confirm the lightbox looks/behaves right in the browser (only the user can see the live UI).

## Open questions / follow-ups
- **#885** — Playwright test for the lightbox open state (image loads on click, Esc/backdrop closes); repo has no jsdom for the dialog/streaming components, so open-state is browser-verified only.
- **#881** — `CustomerContextChatPanel.tsx` (booking-flow / quote / itinerary embeddable panel) still renders content raw with no `renderMessageContent` — display-asset markers show literally there. Not yet scheduled.
- "AI temporarily unavailable" root cause was the Booking tenant hitting the AI hard-cost gate; #880 now exempts `is_platform_internal` tenants. Watch for recurrence on other internal tenants.

## Note
- Transient GitHub 502 during the #884 merge left a stuck "merge in progress" lock for ~3 min; the squash-merge eventually completed on retry. Nothing lost.
