# Admin Console — Home / landing page spec

**Screen:** the Admin Console start page (the route that currently renders just "Admin Console — Manage your workspace…" followed by cards that **repeat the left-nav items**).
**Problem:** the landing page duplicates the sidebar — zero added value.
**Goal:** replace it with a real **dashboard home** that gives admins at-a-glance status, setup progress, and quick actions — and **works in both light and dark themes.**
**Reference build:** `Admin Console - Home.html` — a working mock of the target. Treat it as the source of truth for layout, tokens, and components; this doc explains intent + must-haves.

---

## 0. Theme system — light AND dark (non-negotiable)

Drive everything from CSS variables on a `data-theme` root (or class). Persist the choice; respect `prefers-color-scheme` on first load (no flash). Put a theme toggle in the top bar. **Never hard-code a hex in a component — always reference a token**, so both themes work for free. Light is the app's current default.

```css
:root{
  --accent:#5DADE2; --accent-2:#7CC2EE; --accent-ink:#04121F;
  --green:#34D399; --amber:#F0B45A; --red:#F0746A;
  --r-sm:9px; --r:13px; --r-lg:18px;
}
[data-theme="light"]{
  --bg:#EEF3F8; --sidebar:#FFFFFF; --surface:#FFFFFF; --surface-2:#F4F8FC;
  --hover:rgba(10,35,66,.04);
  --border:rgba(10,35,66,.10); --border-2:rgba(10,35,66,.16);
  --text:#0A2342; --text-soft:#46586B; --text-mute:#7C8DA0;
  --accent:#2E92D6; --accent-2:#1E6FA8; --accent-ink:#FFFFFF;
  --accent-soft:rgba(46,146,214,.12);
  --good-soft:rgba(30,138,91,.12); --amber-soft:rgba(214,142,40,.14);
  --green:#1E8A5B; --amber:#C6881C; --red:#C0563B;
  --track:rgba(10,35,66,.08);
  --hero-grad:linear-gradient(135deg,#0A2342 0%,#12395f 65%);
}
[data-theme="dark"]{
  --bg:#0A1119; --sidebar:#0B1521; --surface:#0F1C2B; --surface-2:#152639;
  --elevated:#18293D; --hover:rgba(255,255,255,.05);
  --border:rgba(255,255,255,.08); --border-2:rgba(255,255,255,.14);
  --text:#EAF1F8; --text-soft:#9DB0C2; --text-mute:#64768A;
  --accent-soft:rgba(93,173,226,.14);
  --good-soft:rgba(52,211,153,.14); --amber-soft:rgba(240,180,90,.15);
  --track:rgba(255,255,255,.09);
  --hero-grad:linear-gradient(135deg,#10283f 0%,#0c1a2a 60%);
}
```

Theme rules that keep both correct:
- The **accent shifts** per theme (`#2E92D6` on light for legibility on white, `#5DADE2` on dark). Use `--accent`, never the raw hex.
- The **hero card stays a dark navy gradient in both themes** (`--hero-grad`) — white text on it always; keep its CTA contrast.
- Success/amber/red get a darker variant on light (`--green` etc.) so colored text passes AA on white.
- The **compass logo mark** uses `currentColor` for navy/white parts (flips per theme) with the sky-blue blade fixed at `#5DADE2`.
- Verify AA contrast for `--text-soft` / `--text-mute` on `--bg` and `--surface` in **both** themes.
- Keep a short `transition: background .3s, color .3s` on the theme-bearing surfaces for a smooth toggle.
- Tailwind: wire as `darkMode:"class"` tokens (or CSS vars in `@theme`), not scattered `dark:` one-offs.

**Type:** Plus Jakarta Sans (UI), JetBrains Mono (numeric/meta: timestamps, "84% · resets July 1", card values). No Inter/Roboto/Arial.

---

## 1. Layout

Keep the existing shell — top bar + left sidebar — and replace only the main content with the dashboard. Add a **Home** item at the top of the sidebar (above "Account") and make it the default route. Main content sits in a centered `max-width:1100px` column.

```
Top bar:  [sidebar toggle]  ⚓ AI Travel Concierge | ADMIN CONSOLE   … [Help & docs] [theme] [avatar]
Sidebar:  Home · Account(Billing, Team) · Workspace(…) · Developer(API) · Usage & Compliance(…)
Main:     Hero → Stat row → (Setup checklist | Quick actions) → (Recent activity | Plan & health)
```

---

## 2. Sections (top → bottom)

### A. Welcome hero
Dark navy gradient card. Eyebrow = workspace name + date ("Sunset Voyages Travel · Wednesday, June 22"), `h1` greeting ("Welcome back, {firstName}."), one status sentence, then two CTAs: **Open agent console** (primary, accent) and **Invite a team member** (ghost). Subtle concentric-circle nautical motif in the corner (decorative, low-opacity).

### B. Stat row — "This month at a glance"
Four stat cards (icon, optional trend pill, big tabular-nums value, label, optional progress bar + mono sub-line):
1. **Conversations** — e.g. 1,284, ▲18% vs last month
2. **AI messages sent** — e.g. 2.4k, with "~31 hrs of desk time saved"
3. **Chat limit used** — 8,420 / 10k, amber progress bar at 84%, "resets July 1"
4. **Team members** — 6 / 8 seats, progress bar, "2 seats available"

Wire these to real workspace metrics where available; the chat-limit and seats values should reflect the actual plan.

### C. Setup checklist + Quick actions (two columns)
- **Finish setting up your workspace** card: header with "{n} of {m} complete" + percent, a progress bar, and a list of steps with a checkbox, title, description, and a hover "→" action. Done steps show a green check; pending steps link to the relevant settings page. Derive completion from real config state (host connected, branding set, personas customized, agent invited, email templates verified, AI mode chosen). Hide the whole card once 100% complete.
- **Quick actions** card: 2×2 grid of shortcut buttons → Invite a member, Edit AI personas, Update branding, Manage billing. Each routes to the matching settings page.

### D. Recent activity + Plan & health (two columns)
- **Recent activity** card: header with "View all →", then a feed of events (colored icon chip + sentence + relative time): host reconnected, member joined, chat-limit warning, persona updated, template published. Pull from the real audit/activity log.
- **Plan & workspace health** card: plan badge + name + price, billing cycle / seats / payment method / status rows, an **Upgrade plan** button, divider, then a **Workspace health** list — green checks for connected host / content safety / branding, an amber warning with a "Fix →" link for anything unset (e.g. AI mode). Health items reflect real config.

---

## 3. Components & states
- **Stat / setup / activity / plan** are all `--surface` cards with 1px `--border`, `--r-lg` radius, and the token shadow.
- Progress bars: track `--track`, fill `--accent` (or `--amber` when near/over limit).
- Quick-action tiles: `--surface-2`, hover raises border to `--accent` + slight lift.
- Empty states: if there's no activity yet, show a friendly "Nothing yet — your AI crew's actions will appear here" instead of an empty list.
- Loading: skeleton blocks for stat values and activity rows while data fetches.

---

## 4. Guardrails & acceptance
- [ ] **Both themes fully correct** — toggle works, choice persists, respects system pref, no flash; AA contrast in each; nothing hard-codes a color outside the token sets.
- [ ] Landing page no longer duplicates the sidebar — it's a dashboard.
- [ ] "Home" added to the sidebar and is the default admin route.
- [ ] Hero, 4 stat cards, setup checklist, quick actions, recent activity, and plan/health all present.
- [ ] Stats, seats, chat limit, setup completion, activity, and health bind to **real** workspace data (no permanently hard-coded numbers).
- [ ] Setup card hides at 100%; quick actions and "Fix →" links route to the correct settings pages.
- [ ] Logo mark + wordmark in the top bar; mark adapts to theme.
- [ ] Reuse existing app components (cards, buttons, nav) rather than duplicating; match the reference build's spacing, radii, and tokens.
- [ ] Don't change settings logic or routes other than adding the Home route.
```
```
