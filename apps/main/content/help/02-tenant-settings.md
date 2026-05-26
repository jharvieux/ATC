---
title: Tenant settings overview
slug: tenant-settings
order: 2
category: setup
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Tenant settings overview

> **Available on:** all tiers.

Your tenant settings live under the **Settings** menu in the top
navigation. This page is a map — what each settings page does, and
when you'd use it.

[Screenshot: top navigation showing the Settings dropdown open]

## Pages, top to bottom

### AI Mode

Controls whether the AI sends messages directly to your customers, or
writes drafts your team approves first, or stays off entirely.

Most tenants start in **Draft only** mode for the first two weeks, then
switch to **Autonomous** once they trust the AI.

See [AI Mode](./settings-ai-mode) for the full walkthrough.

### Branding

Logos, colors, slogan, outbound email settings, custom-domain request.
See [Branding](./03-branding).

### AI Personas

The six built-in AI personalities. Rename them, disable any you don't
want, and (on Pro and above) add written instructions per persona.
See [Personas](./04-personas).

### Host integration (BYO tiers only)

Where you paste your Anthropic API key. BYO tenants only — subscription
tenants don't see this page because we provide the key.

### Team and permissions

Invite teammates, assign roles, remove access when someone leaves.
See [Team and permissions](./09-team-and-permissions).

### Subcontractors (Pro and above)

If you outsource customer chat reviews to a third party, list them here
and grant scoped access. The platform audits every action so you can
prove compliance later.

### Billing

Your subscription plan, invoice history, payment method. Stripe
Customer Portal is one click away — that's where you update card
details or download paid invoices.

See [Usage and billing](./08-usage-and-billing).

### Usage

This month's message count, token usage, RAG retrievals, and (on BYO
tiers) your live Anthropic spend. Updated every five minutes.

See [Usage and billing](./08-usage-and-billing).

### Privacy

Data export, account deletion, customer data retention windows, cookie
preferences. Some controls are required to be visible per privacy law;
you can't hide this page even if you don't use it.

## Settings the platform sets for you

Some things look like settings but aren't editable per-tenant:

- **AI model version** — we pick a recent Claude model on your behalf.
- **Supervisor and quality thresholds** — set at platform level for
  safety. See [Supervisor and quality](./11-supervisor-and-quality).
- **Rate limits** — generous by default; raised individually if you
  bump into them. Email support.

## When something looks wrong

If a settings page won't save, looks blank, or returns "permission
denied":

1. Confirm you're signed in as a user with the right role
   (see [Team and permissions](./09-team-and-permissions)).
2. Check the bottom of the page for a **Report a bug** link.
3. Email support with a screenshot of the error.

See [Troubleshooting](./12-troubleshooting) for common issues.
