---
title: Usage and billing
slug: usage-and-billing
order: 8
category: ops
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Usage and billing

> **Available on:** all tiers — but what you see and pay for depends
> on whether you're on a BYO tier or a Subscription tier.

This page explains where to find your usage, what it costs, and how
billing works.

## Two pages to know

### Settings → Usage

Live counters, updated every five minutes:

- Messages this month
- Conversations this month
- AI tokens consumed (broken down by AI service)
- RAG retrievals
- Pre-cruise emails sent
- (BYO tiers only) live Anthropic spend in USD

[Screenshot: Settings → Usage page with the live counter cards]

### Settings → Billing

Your subscription details, payment method, invoice history.

The **Open Stripe Customer Portal** button takes you to Stripe where
you can update card details and download paid invoices.

[Screenshot: Settings → Billing showing subscription status and the Stripe portal link]

## BYO tiers — what you pay

If you're on a Bring-Your-Own (BYO) tier:

- **Platform fee** — a monthly software fee charged to your payment
  method on file. This covers the platform itself.
- **Anthropic AI cost** — billed directly by Anthropic to the account
  whose API key you pasted. **The platform never sees or touches your
  Anthropic bill.**

To see your Anthropic spend, log in to `console.anthropic.com` →
**Usage**. The platform shows an estimated spend on the Usage page,
but Anthropic is the source of truth.

### Watching for runaway AI costs

A poorly-configured concierge can use more AI tokens than you expect.
The platform's **Settings → Usage** page shows a daily and monthly
spend curve. Two things to do if it looks high:

1. Switch AI mode from **Autonomous** to **Draft only** while you
   investigate.
2. Email support — we can help you find the cause (usually a runaway
   conversation or a tenant member testing in production).

## Subscription tiers — what you pay

If you're on a subscription:

- **Monthly subscription fee** for your tier — charged on the same
  calendar day each month.
- **AI cost is included.** The platform pays Anthropic on your behalf.

### What's included by tier

| Tier | Messages/month | Users | White-label | Personas addendum | Group bookings |
|---|---|---|---|---|---|
| Starter | up to 5,000 | 1 | with attribution | — | — |
| Pro | up to 25,000 | up to 5 | full | yes | yes |
| Agency | up to 100,000 | up to 25 | full | yes | yes (advanced) |

### Going over your message allowance

The platform doesn't cut you off mid-conversation. If you exceed your
tier's allowance:

1. The platform emails you when you hit 80%, 100%, and 120%.
2. Overage is billed on your next invoice at a per-message rate (shown
   in Settings → Billing).
3. If overage continues for two months, our team reaches out to
   discuss the right tier for your usage.

## Invoices

Stripe sends a paid invoice to your billing email after each
successful charge. Past invoices are available in the Stripe Customer
Portal.

If you need an invoice with custom line items, your business name on
the invoice, or split billing across departments — email
`billing@ai-travelconcierge.com` and we'll set it up.

## Changing your subscription tier

You can change tier mid-month:

1. **Settings → Billing → Change tier**.
2. Pick the new tier.
3. **Upgrades** take effect immediately; you're billed the prorated
   difference.
4. **Downgrades** take effect at the start of your next billing cycle.

## Cancelling

We're sorry to see you go.

1. **Settings → Billing → Cancel subscription**.
2. Pick a reason (helps us improve).
3. Your tenant stays active until the end of your current billing
   period — no surprise shutoffs.

After cancellation:

- Customer chat is paused.
- You can still log in to export data for 30 days.
- After 30 days, the tenant is archived (data kept but inaccessible).
- After 90 days, the data is permanently deleted (per our data
  retention policy).

## Frequently asked

**My card was declined.** Stripe emails you with a one-click link to
update the card. Update it within 7 days to avoid service interruption.

**Can I pay annually?** Yes, on Pro and Agency. Email
`billing@ai-travelconcierge.com` and we'll set up annual invoicing —
typically with a 10% discount.

**I'm on BYO and my Anthropic bill seems wrong.** That's between you
and Anthropic. We can help you identify which platform features are
driving cost, but the bill itself comes from them.

See [Troubleshooting](./12-troubleshooting) for what to do if a
subscription invoice didn't generate.
