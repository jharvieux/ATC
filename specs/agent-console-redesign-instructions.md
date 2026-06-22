# Agent Console — redesign spec

**Screen:** the main agent-facing chat console (the screen with "Speaking with", the conversation list, and the chat thread).
**Reference build:** `Agent Console — Redesign.html` — a working interactive mock of the target. Treat it as the source of truth for layout, tokens, and interactions; this doc explains the intent and the must-haves.
**Goal:** modernize the screen and ship four specific structural changes. **Everything must work in both light and dark themes.**

---

## The four changes (do all of these)

1. **Merge the two left columns into one sidebar.** Today there's a conversation-list column *and* a separate "Chat ▸ History / Memory / Prefs" column showing "No conversations yet." Collapse them into a single left sidebar with a segmented control at the top: **Chats · Memory · Prefs**. The conversation list lives under **Chats**; Memory and Prefs swap into the same panel. Delete the redundant second column entirely.

2. **Make "Draft a reply" an inline tab, not a new screen.** Remove the "Draft a reply" link from the sidebar. Add a tab row at the top of the main panel: **Conversation | Draft a reply**. Selecting "Draft a reply" swaps the main panel content in place (same route/screen) — it must NOT navigate away or open a new page.

3. **Replace the agent dropdown with a rich picker that shows bios.** The plain "Speaking with [select]" becomes a chip (avatar + name + region + chevron). Clicking it opens a popover listing each specialist with: avatar, name, **region/specialty**, a one-line **bio**, **expertise tags**, and a **"Best for:"** line — plus a search field. Selecting an agent updates the chip, the thread author, the composer placeholder, and the draft-tool byline. This directly answers "how do I show bio info to pick the right agent."

4. **Modernize the visual design.** Sleeker dark theme (keep dark as default — it's the app's native mode), avatar-led message rows, a real rounded composer, softer surfaces and borders, the brand navy/sky palette, and the nautical compass mark. Demote the big orange "reviewed for quality" bar to a small amber status pill in the header.

---

## 0. Theme system — light AND dark (non-negotiable)

Drive the whole screen from CSS variables on a `data-theme` (or class) at the root. Persist the user's choice and respect `prefers-color-scheme` on first load (no flash of wrong theme). Put a theme toggle in the top bar. **Never hard-code a hex in a component — always reference a token**, so both themes work for free.

```css
:root{
  --accent:#5DADE2; --accent-2:#7CC2EE; --accent-ink:#04121F;
  --green:#34D399; --amber:#F0B45A;
  --r-sm:9px; --r:13px; --r-lg:18px;
}
[data-theme="dark"]{
  --bg:#0A1119; --sidebar:#0B1521; --surface:#0F1C2B; --surface-2:#152639;
  --elevated:#18293D; --hover:rgba(255,255,255,.05);
  --border:rgba(255,255,255,.08); --border-2:rgba(255,255,255,.14);
  --text:#EAF1F8; --text-soft:#9DB0C2; --text-mute:#64768A;
  --user-bubble:#193550; --user-border:rgba(93,173,226,.3);
  --accent-soft:rgba(93,173,226,.14);
}
[data-theme="light"]{
  --bg:#EEF3F8; --sidebar:#FFFFFF; --surface:#FFFFFF; --surface-2:#F1F6FB;
  --elevated:#FFFFFF; --hover:rgba(10,35,66,.04);
  --border:rgba(10,35,66,.10); --border-2:rgba(10,35,66,.17);
  --text:#0A2342; --text-soft:#46586B; --text-mute:#7C8DA0;
  --accent:#2E92D6; --accent-2:#1E6FA8; --accent-ink:#FFFFFF;
  --user-bubble:#E2EFFA; --user-border:rgba(46,146,214,.35);
  --accent-soft:rgba(46,146,214,.12);
}
```

Notes that keep both themes correct:
- The **accent shifts** between themes (`#5DADE2` on dark, a darker `#2E92D6` on light) so it stays legible on white. Use `--accent` everywhere, never the raw hex.
- **Agent avatar gradients are theme-independent** (same on both) — they read fine on either background.
- The **compass mark** uses `currentColor` for its white/navy parts (so it flips per theme) and keeps the sky-blue blade fixed at `#5DADE2`.
- Verify AA contrast for `--text-soft`/`--text-mute` on `--bg` and `--surface` in **both** themes.
- Tailwind users: wire these as `darkMode:"class"` tokens (or CSS vars in `@theme`) rather than `dark:` one-offs scattered per element.

**Type:** Plus Jakarta Sans for UI, JetBrains Mono for metadata (timestamps, msg counts, port lists). No Inter/Roboto/Arial.

---

## 1. Layout

```
┌ Top bar ───────────────────────────────────────────────┐
│ [sidebar toggle]  ⚓ AI Travel Concierge      [theme] [≡]│
├──────────────┬─────────────────────────────────────────┤
│  SIDEBAR     │  MAIN                                    │
│  New chat    │  [Speaking with ▸ agent chip]  [TA mode][Reviewed for quality]
│  Search      │  ── Conversation | Draft a reply ──      │
│  Chats·Mem·Pref│  (tab content swaps below)             │
│  ───────────  │  messages…                              │
│  conv list /  │  ───────────────────────────────        │
│  memory /     │  [ composer …………………… 📎  ➤ ]          │
│  prefs panel  │                                         │
└──────────────┴─────────────────────────────────────────┘
```

- **Top bar** (~58px): sidebar-toggle, brand (compass mark + wordmark, "AI" in accent), spacer, **theme toggle**, menu. Background `--sidebar`, 1px `--border` bottom.
- **Sidebar** (~300px, bg `--sidebar`): New-chat button (solid accent), search input, the **Chats/Memory/Prefs** segmented control, then a scroll area that renders the active panel.
- **Main** (bg `--bg`): header (agent chip + status pills), tab row, then the active view (Conversation or Draft).

---

## 2. Sidebar — merged, three panels

**Segmented control** at top switches the panel below (underline-style tabs).

- **Chats:** date-grouped list ("Today" / "Earlier"). Each row: active dot, title (or italic "Untitled"), and a mono meta line `4 msgs · 6/19/2026`. Active row uses `--surface-2` + `--border`. Give real conversations titles instead of "(untitled)" when a first message exists.
- **Memory:** "Remembered for this client" — rows of `{icon, KEY, value}` for facts the AI is holding (client name, stateroom preference, sailing, budget). Each row removable. This replaces the old empty "Memory" tab.
- **Prefs:** workspace settings as labeled rows — Default agent (select), Reply tone (select), **Quality-review notice** (toggle that shows/hides the header quality pill), Compact density (toggle).

---

## 3. Main header

- **Agent chip** (left): rounded button — avatar, a small "SPEAKING WITH" label, the agent name + region, and a chevron. Hover raises the border; open state gets an accent ring (`--accent-soft`).
- **Status pills** (right): a small `TA mode` pill (accent) and a `Reviewed for quality` pill (amber, shield icon). These replace the full-width orange banner. The quality pill is toggled by the Prefs setting.
- **Tab row** below: `Conversation` and `Draft a reply` (with a tiny "AI" badge). Active tab has a 2px accent underline.

---

## 4. Conversation view

- **Message rows:** avatar + author + mono timestamp, then the content. AI messages sit in a `--surface` bubble with a flat top-left corner; **user messages right-align** in a `--user-bubble` with the mirrored corner. Constrain the thread to ~780px and center it.
- AI message hover actions: **Copy · Use in a reply · Regenerate**.
- Port/place names can be tinted with `--accent-2` for scannability.
- **Composer:** rounded `--surface` field, auto-grow textarea, attach button, solid-accent send button; focus ring uses `--accent-soft`. Helper line under it: "{Agent} is an AI specialist · Trade-mode answers, no customer guardrails."
- Keep the floating **"New message ↓"** jump pill.

---

## 5. Draft-a-reply view (inline tab)

Renders in place when the tab is active:
- Title + one-line explainer ("turns this conversation into a client-ready message, in your voice — stays here as a tab, no screen switch").
- **"What did your customer ask?"** textarea.
- **Tone** chips (Warm / Concise / Detailed / Reassuring), single-select.
- A byline "Drafting as {active agent}" + a **Draft reply** button.
- **Output card:** header (agent avatar + "Suggested reply · in your voice" + "Ready to send"), the drafted body, and a footer: **Copy · Open in email · Regenerate**.

The active agent flows into this view (byline + avatar) so it stays consistent with the picker selection.

---

## 6. Agent picker (the bio solution)

Popover anchored under the agent chip; backed by a scrim; closes on outside-click or Esc. Each agent is data:

```
{ id, name, region, initials, gradient,
  bio,            // one sentence — why you'd pick them
  tags:[...],     // expertise chips: regions, ships, specialties
  bestFor }       // "Best for: …" one-liner
```

Seed the six specialists from the reference build (Captain Dave Kowalski · Alaska; Priya Sharma · Luxury & Suites; Marco Rossi · Mediterranean; Yasmin Okonkwo · Caribbean; Eleanor Whitfield · River; Sam Reyes · Accessibility & Groups). Row layout: avatar, name + ✓ if active, region (accent), bio, tag chips, "Best for:" line. Top of the popover has a **search** that filters across name/region/tags/bio. Selecting a row updates: the chip, the thread author name + avatar, the composer placeholder/helper, and the draft byline.

---

## 7. Guardrails & acceptance

- [ ] **Both themes fully correct** — toggle works, choice persists, no theme flash, AA contrast in each. Nothing hard-codes a color outside the token sets.
- [ ] Two left columns merged into one sidebar with Chats/Memory/Prefs.
- [ ] "Draft a reply" is an inline tab; it never navigates to a new screen.
- [ ] Agent picker shows bio + tags + "Best for" and is searchable; selection propagates everywhere.
- [ ] Orange banner replaced by the amber header pill (toggleable via Prefs).
- [ ] Messages avatar-led; user messages right-aligned; modern rounded composer.
- [ ] Compass mark + wordmark in the top bar; mark adapts to theme.
- [ ] Keyboard: Esc closes the picker; tabs and toggles are focusable.
- [ ] Don't change backend/chat logic — this is a UI restructure of the existing screen.
- [ ] Match the reference build's spacing, radii, and tokens; reuse existing app components where they already exist rather than duplicating.
```
```
