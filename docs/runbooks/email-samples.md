# Email samples — rendering customer-facing templates for review

When you want to see what a tenant's customer will actually receive — for design review, brand-color tuning, copywriting feedback, or showing stakeholders — run the sample renderer.

## What the renderer covers

Six customer-facing emails, all of them production templates rendered with realistic sample data:

| Template | When sent | Notes |
|---|---|---|
| `PreCruiseT90` | 90 days before sailing | Destination teasers, must-do experiences, suggested reads |
| `PreCruiseT30` | 30 days before sailing | Reservation reminders, check-in window, packing inspiration |
| `PreCruiseT7` | 7 days before sailing | AI-generated packing checklist, ship highlights, embarkation tips |
| `PreCruiseT1` | 1 day before sailing | Carry-on essentials, port directions, **live weather forecast** |
| `GroupInvitation` | When a coordinator invites someone to a group | Cabin counts (anonymized per §18.6), invite link, optional group rate |
| `GroupBroadcast` | When a coordinator messages existing group members | Free-form subject + message, paragraph-split |

The T-1 email calls Open-Meteo directly for live Miami weather — no API key required (Open-Meteo is free-tier). It bypasses the DB cache + rate-limit gate from `lib/weather/open-meteo.ts` so the sample run doesn't touch any DB.

## How to run

```bash
pnpm tsx scripts/render-email-samples.tsx
```

Output lands in `/tmp/`:

- `/tmp/sample-precruise-t90.html`
- `/tmp/sample-precruise-t30.html`
- `/tmp/sample-precruise-t7.html`
- `/tmp/sample-precruise-t1.html`
- `/tmp/sample-group-invitation.html`
- `/tmp/sample-group-broadcast.html`

Open any of them in a browser. Each file is self-contained — no external CSS, no external images. The container is centered at 680px with a card-style drop shadow to roughly approximate a Gmail render.

## Tuning the sample

All sample constants live at the top of `scripts/render-email-samples.tsx`:

- `SAMPLE_LAYOUT` — tenant branding (primary color, accent color, slogan, legal name, address, unsubscribe URL).
- `SAILING_DATE`, `SHIP`, `CRUISE_LINE`, `CUSTOMER` — the cruise context.
- `MIAMI_LAT` / `MIAMI_LON` — coordinates for the weather call.
- `COMPANION_PAGE` — the per-booking companion page URL.

To render samples for a different tenant:

1. Swap `SAMPLE_LAYOUT` with their branding (colors, legal name, address).
2. Swap the cruise constants for the itinerary you want to demo.
3. Re-run.

To render samples for a different group scenario, edit the props inside the `renderToStaticMarkup(...)` blocks for `GroupInvitation` and `GroupBroadcast` near the bottom of the script.

## What's intentionally NOT in this renderer

- **AI-generated content is hand-written.** Production fills `destination_teaser`, `must_do_experiences`, `packing_checklist`, etc. via Haiku at send-time. The script uses hand-written prose so the renders show what the template *layout* produces, not how the AI will sound. Real emails will have different voice in those slots — same structure.
- **No tenant logo.** Production passes `branding.logo_url`; the script leaves it null so the default text-only branding renders. To preview with a logo, set `branding.logo_url: "https://..."` in `SAMPLE_LAYOUT`.
- **No Resend send.** This script writes HTML files, period. It does not call Resend, does not consume any send quota, and does not write to `email_log`.

## When NOT to use this script

- **For automated regression tests.** This is a one-off visual review tool. Email template tests live in `apps/main/test/unit/email/`.
- **For real customer previews.** The companion-page URL is fictional. For per-booking real previews, use the production pipeline's preview mode (TBD) or read directly from `email_log` after a real send.
- **For verifying the weather cache.** The script bypasses the cache. Use the actual helper (`getEmbarkationForecast`) via a backend test if you want to exercise that path.

## Related

- Spec §23.4 (Pre-cruise email series)
- Spec §18 (Groups)
- `apps/main/src/inngest/precruise-generate-and-send.ts` — production pipeline
- `lib/weather/open-meteo.ts` — weather helper (production)
- D-123 in `MEMORY.md` — weather integration shipping context
