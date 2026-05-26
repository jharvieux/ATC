---
title: Quickstart — Bring-Your-Own (BYO) tiers
slug: quickstart-byo
order: 0
category: setup
tiers: [byo_research, byo_professional, byo_agency]
---

# Quickstart — Bring-Your-Own (BYO) tiers

> **Available on:** BYO Research, BYO Professional, BYO Agency.

Welcome. This page walks you through your first hour on the platform if
you signed up on a Bring-Your-Own (BYO) tier — meaning you provide your
own Anthropic API key and the platform charges you a monthly software
fee rather than per-message.

There is no jargon here. If a word doesn't make sense, search the help
center — and if it still doesn't, click **Report a question** so we can
explain it better in the next update.

## Step 1 — Find your Anthropic API key

You'll need an API key from Anthropic, the company that makes the AI
model that powers your concierge.

1. Go to `console.anthropic.com` in another tab.
2. Sign up or log in. (You can use the same email you used here.)
3. From the left menu pick **API Keys**, then **Create key**.
4. Copy the key — it starts with `sk-ant-`.

[Screenshot: Anthropic console, API Keys page, the "Create key" button]

> **Important:** This key is like a credit card. Don't share it. We
> store it encrypted, and only your tenant can use it.

## Step 2 — Paste your key into the platform

Back in the platform:

1. Open **Settings → Host Integration**.
2. Paste your key in the **Anthropic API key** field.
3. Click **Save and test**. The platform sends one tiny test message to
   confirm the key works.

[Screenshot: Settings → Host Integration with the API key field and Save and test button]

If the test fails, the most common reason is that you have no funds in
your Anthropic billing account. Add a payment method on the Anthropic
side and try again.

## Step 3 — Set your branding (optional, 5 minutes)

You can launch without branding, but customers respond better when they
see your name and colors.

1. Open **Settings → Branding**.
2. Paste logo URLs (light mode and dark mode — they can be the same).
3. Pick your primary, secondary, and accent colors.
4. Write a one-line slogan.
5. Click **Save**.

See the [Branding](./03-branding) help page for what each field does and how
to test your branding before customers see it.

## Step 4 — Invite teammates (optional)

If you work with other people:

1. Open **Settings → Team and permissions**.
2. Click **Invite a teammate**, enter their email, pick a role.

See [Team and permissions](./09-team-and-permissions) for what each role can do.

## Step 5 — Share your concierge with one customer

Don't tell everyone yet. Pick one customer you trust:

1. From your home dashboard, copy the link under **Your concierge URL**.
2. Send it to one customer with a note: "Try our new AI assistant — let
   me know what works and what doesn't."
3. Watch the **Conversations** page to see what they ask.

[Screenshot: home dashboard with the Your concierge URL panel highlighted]

This soft launch with one customer catches 90% of surprises before you
share with your whole list.

## What to do next

- **First week:** check **Conversations** daily for issues. Use
  **Mark as bad answer** when the AI says something wrong — that
  teaches the platform.
- **First month:** read [Usage and billing](./08-usage-and-billing) so
  you understand what your Anthropic costs look like.
- **When ready to scale:** see
  [RAG content](./07-rag-content) for how to feed your concierge your
  own knowledge.

## Need help?

Click **Report a question** at the bottom of any page and our support
team will respond within one business day.
