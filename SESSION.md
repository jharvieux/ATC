# Session state — last updated 2026-06-08

## Just completed
- **#889 — email_customer tool (deployed).** The concierge can now email a SIGNED-IN customer the info they ask for (deck-plan links, itinerary, quote) via Resend, from the persona's address (e.g. marcus@ai-travelconcierge.com). Recipient is the account email resolved server-side — never model-chosen (no open relay). Rate-limited via a new `concierge` category (10/24h per recipient). Opus-audited, both agents clean. MEMORY D-191. atc-main deployed (dpl 9k16d5703).
- Earlier this session (all live): #887 lightbox labels + mobile modal (D-190), #884 on-page lightbox (D-189), #882 display-asset SSE wiring, #880 AI-cost-gate exemption (fixed "AI temporarily unavailable"), #868 retrieval stack.

## In flight
- Nothing in flight — clean checkpoint. dev = 21dfc40a.

## Next step
- **Browser-verify #889 in prod:** as a SIGNED-IN customer, ask the concierge "email me the deck plans" → expect an email from marcus@ai-travelconcierge.com with the links. As ANONYMOUS, ask the same → the concierge should say to sign in first.

## Blocked on user
- Confirm the email actually arrives (deliverability) and looks right — only the user can check the inbox.

## Open questions / follow-ups
- **#890** — inbound replies to the persona address (marcus@…) aren't handled; reply-to points at tenant support_email. Decide: confirm reply-to is sufficient (document send-only) vs route inbound to support.
- **#885** — Playwright test for the asset-lightbox open state.
- **#881** — `CustomerContextChatPanel.tsx` renders display-asset markers raw (no renderMessageContent).
- "AI temporarily unavailable" root cause was the Booking tenant hitting the AI hard-cost gate; #880 exempts `is_platform_internal` tenants. Watch for recurrence.

## Notes
- email_customer uses `platform_resend` from marcus@ai-travelconcierge.com (verified platform domain). A signed-in user needs a real `public.users.email` for the send to work; if a signed-in account has no email row, the tool reports not-sent.
