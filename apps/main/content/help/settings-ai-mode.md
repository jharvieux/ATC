---
title: AI Mode
slug: settings-ai-mode
order: 2.5
category: setup
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# AI Mode

> **Available on:** all tiers. **Where to find it:** Settings → AI Mode.

AI Mode is the single most important setting on the platform. It decides
how much of your customer conversation the AI handles on its own, and how
much waits for a human to approve. This page explains the three modes,
when to pick each one, and what changes when you switch.

[Screenshot: AI Mode page showing three mode cards stacked vertically]

## The three modes at a glance

| Mode | What customers see | What you do |
|---|---|---|
| **Autonomous** | AI answers immediately, in your brand voice | Read transcripts after the fact; jump in only when you want to |
| **Draft Only** | AI answers feel slower — there's a wait for your approval on each reply | Open every draft, edit if needed, click **Send** |
| **Disabled** | No AI reply at all on the chat surface; customer waits for a human | You handle every message yourself |

You can switch modes anytime. Switching does not delete drafts, change
past conversations, or affect bookings already in flight.

## When each mode is right

### Autonomous

Pick Autonomous when:

- You've watched the AI answer real customer questions for at least a
  week and you trust the quality.
- Your message volume is too high to review every reply by hand.
- You want 24/7 coverage — the AI keeps answering while you sleep.

Most tenants who start in Draft Only graduate to Autonomous after their
first 50–100 conversations.

### Draft Only (recommended for new tenants)

Pick Draft Only when:

- You just activated and want to read what the AI is writing before any
  customer sees it.
- You sell high-touch travel (luxury, complex multi-leg, group of 20+
  cabins) where a wrong word costs you a booking.
- You're testing a new persona or new uploaded knowledge and want to
  catch problems before they reach a customer.

You'll see a yellow **Drafts waiting** badge in the top nav whenever
there's a draft to review. Click it to open the draft, edit if needed,
and click **Send**.

### Disabled

Pick Disabled when:

- You're on vacation and don't want any AI responses going out — even
  drafts.
- Your business is closed for the season and you want customers who
  message to get a human-written holding reply.
- You're investigating a quality issue and want to fully pause the chat
  surface.

In Disabled mode, the AI does not draft, does not respond, and does not
appear in the chat at all. The customer sees your offline message (set
in [Branding](./03-branding)).

## What stays on in every mode

Even in Disabled mode, the AI keeps doing background work that has
nothing to do with the live chat:

- **Memory extraction** — remembering customer preferences from past
  conversations so you don't have to re-ask
- **RAG normalization** — cleaning up the brochures and price sheets you
  upload so the AI can find them later
- **Pre-cruise emails** — personalizing the trip-coming-up emails
- **Forum moderation** — screening posts in group trip forums for spam
  and abuse

This bundle is called **Background AI**. There's a separate toggle for
it on the AI Mode page.

## The Background AI toggle

[Screenshot: Background AI toggle with the amber "OFF" warning visible]

The Background AI switch lives below the three mode cards. Most tenants
leave it **on** all the time. Turn it **off** only if you want a clean
audit window where literally no AI is running on your tenant's data — for
example, during a privacy audit.

When you turn Background AI off:

- Memory extraction pauses (the AI stops learning from new conversations)
- New persona instructions can't be saved (the safety screening that runs
  on persona text is part of Background AI)
- Uploaded documents are stored but not normalized — they won't appear in
  AI answers until you turn Background AI back on
- Pre-cruise emails switch from personalized to plain template wording
- Forum moderation falls back to your manual review

We ask for confirmation before turning Background AI off because most
tenants don't want this. If you click the switch off by accident, click
**Cancel** in the popup.

## How to switch modes

1. Open **Settings → AI Mode**.
2. Click the card for the mode you want. The card you pick is outlined
   in blue with an **Active** badge.
3. The change saves automatically — no Save button.
4. To turn Background AI on or off, click the switch in the second
   section. Turning it off opens a confirmation popup.

## Cost effect

Each mode uses a slightly different amount of AI — Autonomous costs the
most (one full AI response per customer message), Draft Only costs a bit
less (the draft + your edits), and Disabled costs almost nothing on the
chat path. Background AI is a small ongoing cost on its own.

Real numbers for your account show up on the **Usage** page after a
billing period. See [Usage and billing](./08-usage-and-billing).

## When to call support

- The mode card shows the wrong mode after you click — try refreshing
  first; if it persists, **Report a bug**.
- A customer reports they got an AI reply while you were in Disabled
  mode — capture a screenshot of the conversation and **Report a bug**
  immediately. This shouldn't happen.
- You're not sure which mode fits your business — email support and
  describe your weekly conversation volume and how high-touch your
  bookings are.

## Related pages

- [Personas](./04-personas) — the AI's personality, separate from its
  mode
- [Supervisor and quality](./11-supervisor-and-quality) — the safety
  checks that run on every AI reply, in every mode
- [Usage and billing](./08-usage-and-billing) — how mode affects your
  monthly cost
- [Troubleshooting](./12-troubleshooting) — common chat-surface issues
