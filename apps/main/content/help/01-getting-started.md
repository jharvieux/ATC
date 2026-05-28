---
title: Getting started
slug: getting-started
order: 1
category: setup
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Getting started

Welcome. This page walks you through what to expect in your first day on
the platform — what the AI Travel Concierge actually does for you, what
you need to set up before your first customer arrives, and where to go
next.

> **In a hurry?** Jump to the [BYO quickstart](./00-quickstart-byo) or
> [Subscription quickstart](./00-quickstart-subhost) for the 30-minute
> setup checklist.

## What the AI Travel Concierge does

Think of the platform as a junior travel agent that works for you 24/7.
When a customer lands on your branded website, they're greeted by your
AI concierge — which has been trained on your services, your suppliers,
your tone, and your business rules. The concierge can:

- Answer questions about cruise itineraries, ports, cabins, and pricing
- Build quotes and share them with the customer for review
- Capture booking interest and pass it to you to finalize
- Send pre-cruise emails, document confirmations, and follow-up reminders
- Manage a group's invitation thread, RSVPs, and shared trip page

The AI handles routine conversation. You handle the parts that need a
human — final pricing decisions, exception handling, escalations, and
the personal relationship.

You decide how much autonomy the AI has. See [AI Mode](./settings-ai-mode)
for the three settings (Autonomous, Draft Only, Disabled).

## The first dashboard you'll see

When you sign in the first time, you land on the **Home** dashboard. The
left side shows your onboarding checklist:

[Screenshot: home dashboard with onboarding checklist on the left]

| Step | What it does |
|---|---|
| Confirm business identity | Your legal business name, support email, and mailing address. These appear on customer-facing emails and invoices. |
| Pick a tier | Research, Professional, or Agency — choose what fits your volume. You can change tiers later. |
| Connect Stripe | For BYO tenants: not required; you use your own systems. For Subscription tenants: required for monthly billing. |
| Set up branding | Logo, brand colors, sender email. Recommended before you go live so customers see your business, not ours. |
| Add team members | Invite anyone on your team who needs to see the dashboard or take over chats. |
| Submit for review | Once everything looks good, submit. Our compliance team checks within 1 business day and activates your tenant. |

You don't have to complete the checklist in order, but you can't go live
until the review step is done.

## What "active" means

Once we activate your tenant, your AI concierge is live. The moment a
customer visits your branded subdomain (for example,
`yourname.ai-travelconcierge.com`), the concierge greets them and starts
helping.

Every conversation appears in **CRM → Conversations** so you can see
what the AI is saying. If you're in **Draft Only** mode, you'll approve
or edit each AI response before it's sent. In **Autonomous** mode, the
AI sends directly and you review on your own schedule.

## What to do on day one

1. **Personalize your concierge.** Open [Personas](./04-personas), pick
   one of the six built-in personalities, and rename it to something
   your customers will see (e.g., "Sarah at Coastline Travel").
2. **Add your knowledge.** Upload a brochure, a price sheet, or paste
   in your most common FAQs at [RAG content](./07-rag-content). The
   more context you give the concierge, the better its answers.
3. **Try it out.** Open your subdomain in a private browser window and
   chat with the concierge yourself. Ask the kind of questions your
   real customers ask.

## What to do in the first week

- **Add your existing customers.** Import your contact book through
  [CRM](./05-crm). The AI uses this to recognize returning customers
  and skip the introductions.
- **Set your AI mode deliberately.** Most tenants stay in
  [Draft Only](./settings-ai-mode) for the first two weeks — long enough
  to read what the AI is writing and build trust before turning it
  loose.
- **Add a teammate.** Even if you work alone, add a co-worker, a virtual
  assistant, or your manager so someone else can step in if you're
  unreachable. See [Team and permissions](./09-team-and-permissions).
- **Check usage.** After a few days, peek at
  [Usage and billing](./08-usage-and-billing) to see how much of your
  tier's limits you're consuming. Adjust if needed.

## Getting help

- **The little chat bubble at the bottom-right** of every admin page is
  your help concierge — a copy of the same AI your customers use, but
  trained on these help docs. Ask it anything.
- **Report a bug** — there's a link at the bottom of every page. Use it
  when something looks broken; we get a structured report and reply with
  a fix or a workaround.
- **Email support** — your tier's support address is in the footer of
  every admin page.
- **Browse these help docs** — the **Help** menu in the top nav has the
  full table of contents.

## Next steps

- [AI Mode](./settings-ai-mode) — pick how much autonomy the AI gets.
- [Personas](./04-personas) — give your concierge a name and personality.
- [Branding](./03-branding) — make the customer-facing pages look like
  your business.
- [CRM](./05-crm) — get your customer book into the system.
- [Quotes and bookings](./06-quotes-and-bookings) — what happens when a
  customer is ready to book.
