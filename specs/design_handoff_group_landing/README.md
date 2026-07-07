# Handoff: Group Cruise Invite Landing Page

## Overview
A landing page sent to people invited on a group cruise. It needs to be captivating enough to convert an invite into a booking: it shows the trip details, creates social proof / FOMO by surfacing who else is going, gives a taste of the ship and itinerary, previews the group's chat, and lets the guest RSVP.

**Chosen visual direction: "Bright & Vacation-y."** Three directions were explored (bold/festive, bright/vacation-y, elegant/premium) — bright/vacation-y was selected, with a required dark theme variant.

## About the Design Files
The bundled `Cruise Landing.dc.html` is a **design reference built in HTML** — it demonstrates intended look, layout, and behavior. It is not production code to lift as-is. Recreate this design in the target codebase's existing environment (React, Vue, native, etc. — whatever the app already uses), following its established component and state-management patterns. If no environment/framework exists yet for this app, pick the most suitable one and implement the design there.

Open the file directly in a browser to view it. It contains:
- Turn 1, option **1b** — the chosen light-theme design, fully laid out with sample content.
- Turn 1, options **1a** / **1c** — two rejected directions, for context only (ignore for implementation).
- Turn 2, option **2a** — a light-vs-dark color token map to use for the dark theme (see Design Tokens below).

## ⚠️ Critical: this is a generic, data-driven page — nothing is fixed
**Do not treat any cruise line, ship name, itinerary, dates, ports, ship stats, or people/messages shown in the design file as real or fixed content.** They are placeholder sample data used only to demonstrate the layout (in this case a Norwegian Bliss Alaska sailing was used as one illustrative example). The actual page must support **any cruise line, any ship, and any itinerary**, entirely driven by data — see Data Model below. Every string and number that looks like content (ship name, dates, port names, guest counts, stats, names, chat messages) must come from data, never be hardcoded.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and copy tone in the reference should be recreated precisely (adapted to real data), using the codebase's existing UI libraries/primitives where they exist.

## Data Model
Design the page around data shaped roughly like this (rename/restructure to match the codebase's conventions):

```
Trip {
  cruiseLine: string            // e.g. any cruise line, not just one brand
  shipName: string
  shipHeroImageUrl: string | null   // real photo; show a labeled placeholder if absent
  sailDate: date
  nights: number
  departurePort: string
  itinerary: ItineraryStop[]    // ordered, length varies per trip
  shipStats: { guestCapacity: number, decks: number, builtYear: number, signatureFeature: string } // signatureFeature varies per ship (waterslides, go-kart track, etc.) — freeform
}

ItineraryStop {
  dayLabel: string              // e.g. weekday or "Day 3"
  portName: string              // or "Cruising <region>" / "At Sea" for sea days
  arrival: string | null        // null for embarkation/sea days
  departure: string | null
  isSeaDay: boolean
}

RosterEntry {
  id: string
  displayName: string           // or "Anonymous" if anonymous is true
  anonymous: boolean
  avatarUrl: string | null
  avatarColor: string           // fallback initials-avatar color when no photo
  status: 'booked' | 'interested' | 'pending' | null
}
// Booked/Interested/Pending counts shown in the stats row are ALWAYS derived by
// counting RosterEntry.status — never store them as separate numbers.

ForumMessagePreview {
  id: string
  author: RosterEntry (or anonymous)
  text: string
  timestamp: datetime
}

CurrentUser {
  id: string
  rsvpStatus: 'booked' | 'interested' | 'cant' | null
  postAsAnonymous: boolean      // option when RSVPing / posting
}
```

`daysUntilSailing` is always computed from `sailDate - now`, never hardcoded.

## Screens / Views
Single scrolling page, sections top to bottom:

### 1. Nav bar
- Left: small logo mark (rounded-square gradient swatch, brand-configurable) + trip title, e.g. "`{cruiseLine} Group Cruise · {year}`".
- Right: theme toggle (sun/moon pill switch, see Interactions) + small stack of 2 avatar circles (e.g. trip organizers).
- Height ~74px, horizontal padding 40px, bottom hairline border.

### 2. Hero
- Full-width banner, vertical ocean gradient background (light: sky blue → deep blue; dark: navy → near-black with a moon + faint stars — see Design Tokens), a sun/moon disc in the top-right with a soft glow, and a wave-shaped bottom edge transitioning into the page background.
- Eyebrow pill: "Group Cruise Invite" (uppercase, letter-spaced, semi-transparent pill).
- H1 (Quicksand 700, 46px/1.1): "You're invited aboard the `{shipName}`!"
- Subhead (17px/1.6, ~80% opacity): nights + trip flavor line + `{departurePort}` + `{sailDate}`.
- Countdown pill ("☀️/🌙 `{daysUntilSailing}` days to set sail") + a text line of the route as `{departurePort} → {stop1} → {stop2} → …`.

### 3. FOMO stats + social proof
- 3-column stat grid: **Booked**, **Interested**, **Pending** — big numbers (Quicksand 700, 34px), derived counts, color-coded (green/yellow/muted).
- Below it, a single card: overlapping avatar stack (first ~4 roster entries with a status, then a "+N" chip for the rest) + a sentence naming the first few people and the remaining count, e.g. "`{name1}, {name2}, {name3}` + `{n}` others are already booked."
- Anonymous roster entries are excluded from the named list but still counted in the "+N" total and in the stats.

### 4. The Ship
- Two-column: a hero image block for the ship (real photo when available; otherwise a gradient rectangle with a centered "`[ {shipName} — hero photo ]`" label — never fabricate a photo) + a 2×2 stat grid (guest capacity, decks, built year, signature feature).

### 5. Itinerary
- One card per `ItineraryStop`, in a wrapping row (4 columns at this width). Each card: a thin colored top stripe, day label, port/sea-day name, and arrival–departure time range (or "At sea" / "Scenic cruising" for sea days).
- Card count always matches `itinerary.length` — never assume 7 or 8 stops.

### 6. Group Chat preview
- Card listing the 2 most recent `ForumMessagePreview` items (avatar/initials, name — or "Anonymous", relative timestamp, message text) + a footer row with total message count this week and an "Open Group Chat →" button that navigates to the full chat/forum view (out of scope for this page beyond the preview + link).

### 7. RSVP
- Heading + helper copy + 3 buttons: **I'm Interested**, **Can't Make It**, **I've Booked** — a 3-state single-select (only one active at a time), full-page background here is a subtle gradient/surface shift to close the page.
- Include the anonymous-RSVP option here too (e.g. a small checkbox/toggle "RSVP anonymously" near the buttons) since roster entries can be anonymous.

## Interactions & Behavior
- **RSVP buttons**: clicking one sets `CurrentUser.rsvpStatus`; the previously active button (if any) deselects. Selected state = filled/solid pill in the accent color; unselected = outlined/ghost. Updates the stats row's derived counts immediately (optimistic update), then persists to the backend.
- **Theme toggle**: sun/moon pill switch in the nav flips light ⇄ dark. Persist the user's choice (e.g. localStorage or user profile) and default to it on return visits; falls back to system `prefers-color-scheme` if no saved preference.
- **Avatar stack / "+N"**: clicking opens the full guest list (modal or separate route) — out of scope to design in detail here, but must exist.
- **"Open Group Chat"**: navigates to the full forum/chat feature (separate page/route, not built out on this landing page beyond the preview).
- **Hover states**: buttons and the chat CTA get a subtle lift/darken on hover; follow whatever hover convention the codebase already uses for buttons.
- **Loading state**: while trip/roster/chat data is loading, show skeleton placeholders in the stat numbers, avatar stack, itinerary cards, and chat preview — don't show zeros or empty states as if they were real data.
- **Empty states**: if no chat messages yet, show a friendly empty state instead of the preview card ("No messages yet — be the first to say hi"). If itinerary/ship data is incomplete, omit that stat/field rather than showing a fake value.
- **Responsive**: this reference is drawn at a 1040px desktop card width; stack the 3-column stats and 4-column itinerary grids down to 1 or 2 columns on narrower viewports, and reduce the hero H1 size proportionally.

## State Management
- `trip`, `itinerary`, `shipStats`: fetched once per page load (or cached), rarely change.
- `roster`: fetched with the page; counts are derived, not stored separately.
- `currentUser.rsvpStatus`: local optimistic state synced to backend on change.
- `theme`: local/persisted preference, independent of all the above.
- `chatPreview`: fetched with the page; full chat/forum is a separate feature with its own state.

## Design Tokens

### Typography
- Headings: **Quicksand**, weight 700 (H1 46px/1.1, section labels 12px uppercase/letter-spacing .08em, stat numbers 34px, card titles 14–20px).
- Body/UI text: system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`), weights 500–600, 13–17px.
- Google Fonts import: `Quicksand:wght@500;600;700`.

### Spacing & shape
- Section horizontal padding: 40px. Section vertical rhythm: 36–64px between blocks.
- Card radius: 16px (stat/chat/roster cards), 14px (itinerary cards), 999px (pills/buttons/avatars).
- Grid gaps: 12–16px.

### Color — Light theme
| Token | Hex |
|---|---|
| Page background | `#f4faff` |
| Surface / cards | `#ffffff` |
| Text primary | `#0b3a52` |
| Text muted | `#5c7f91` |
| Accent — ocean blue (primary) | `#0f7fa8` |
| Accent — sun yellow | `#ffcc4d` |
| Accent — coral | `#ff8a65` |
| Success / Booked | `#1fa876` |
| Hairline border | `#e4f1f8` |
| Card shadow | `0 4px 16px rgba(15,127,168,.08)` |
| Hero gradient | `linear-gradient(180deg,#bfe6f7 0%,#8ed0ec 45%,#4fa8d8 100%)` |

### Color — Dark theme
| Token | Hex |
|---|---|
| Page background | `#0a1622` |
| Surface / cards | `#11212f` |
| Text primary | `#eaf4fa` |
| Text muted | `#8fadbc` |
| Accent — ocean blue (primary) | `#38b6e8` |
| Accent — moon yellow | `#ffcc4d` |
| Accent — coral | `#ff8a65` |
| Success / Booked | `#34d399` |
| Hairline border | `rgba(255,255,255,.08)` (replaces shadows — dark cards use a 1px border instead of a drop shadow) |
| Hero gradient | `linear-gradient(180deg,#16324a 0%,#0d2233 55%,#081722 100%)` + a soft moon glow + a few faint star dots, replacing the light theme's sun |

Only color tokens change between themes — typography, spacing, radii, and layout are identical in both.

## Assets
- No photography is bundled. The ship hero image is a labeled placeholder rectangle (`[ {shipName} — hero photo ] `) — wire it to real ship photography (CMS-provided or trip-organizer-uploaded) with that placeholder as the empty/loading fallback.
- Avatars are colored initials circles (no photo library used); support real uploaded avatar photos with initials as the fallback.
- Fonts are loaded from Google Fonts (Quicksand); no custom font files needed.

## Files
- `Cruise Landing.dc.html` — open directly in a browser. Option `1b` is the chosen light design with full sample layout; option `2a` (second section) is the light/dark color token map described above.
