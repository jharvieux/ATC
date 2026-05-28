---
title: Troubleshooting
slug: troubleshooting
order: 12
category: ops
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Troubleshooting

Things that go wrong day-to-day and what to do about them. If your
situation isn't here, the bottom-of-page **Report a bug** link sends us
the full context — please use it.

> **Tip:** Try refreshing the page first. About a third of the issues
> tenants report turn out to be a stale browser tab.

## Sign-in and access

### I forgot my password

Click **Forgot password** on the sign-in page. We email a reset link
that's good for 1 hour. The email comes from `noreply@ai-travelconcierge.com`
— check your spam folder if it doesn't arrive in 2 minutes.

### I'm not getting the password reset email

- Check spam / junk.
- Confirm you're typing the email exactly as it's listed in **Team and
  permissions** (lowercase, no typos).
- If it still doesn't arrive, ask a teammate with the **Owner** role to
  open **Team → Members → your name → Send reset link** for you.
- If you're the only Owner and you can't get the email, email support
  with the business name and the email on file. We verify identity
  separately and reset manually.

### "Permission denied" when opening a settings page

This means your user role doesn't include access to that page. Common
causes:

- You were added as an **Agent** but you're trying to open a settings
  page that needs **Manager** or **Owner**.
- Your role was downgraded recently — check with whoever owns the
  account.
- You're signed in as a teammate's account by accident (e.g., a shared
  browser). Click your name in the top-right and confirm.

See [Team and permissions](./09-team-and-permissions) for which roles
see what.

### A teammate I invited didn't get the invitation email

- Ask them to check spam.
- Open **Team → Members**. If their row says **Pending** with a
  **Resend** button, click it. The invitation expires after 7 days, so
  resending is the fix.
- If resending doesn't help and the email address is on a corporate
  domain, their IT may be blocking outside senders. Ask them to
  whitelist `noreply@ai-travelconcierge.com`.

## Customer chat

### A customer can't see the chat widget

- Confirm the customer is on your branded subdomain
  (`yourname.ai-travelconcierge.com`), not the platform root.
- Check **Abuse monitoring** for their identifier — they may have been
  rate-limited or temporarily blocked.
- If they're on a corporate or hotel network, the network may block the
  chat widget. Ask them to try from a phone on cellular.
- Hard-refresh: ask them to press **Ctrl+Shift+R** (or **Cmd+Shift+R**
  on Mac). Cached old code is the most common cause.

### The AI is responding too slowly

A normal AI reply takes 3–10 seconds. If you're seeing 30+ seconds:

- Check **Usage** — if you've hit your tier's rate cap, the AI throttles
  to stay within it.
- Check the platform status page (link in the footer) — there may be a
  vendor outage we're already tracking.
- If it's just your tenant and your usage looks fine, **Report a bug**
  with the conversation ID and the time.

### The AI gave a customer wrong information

Most factual errors get caught by the supervisor. When one slips through:

1. Open the conversation in **CRM → Conversations**.
2. Click the bad message and use **Mark as bad answer**. This trains the
   AI to do better on similar inputs.
3. If the wrong info caused a customer to expect a price, date, or
   booking detail you can't honor — take over the chat, apologize, offer
   the closest honest alternative, and **Report a bug** with the
   conversation ID. We treat AI-made commitments seriously.

### A customer says they got an AI reply but I'm in Disabled mode

This shouldn't happen. Take a screenshot of the customer's view, note
the time, and **Report a bug** right away. We treat this as a
high-priority incident.

### Chat shows in the wrong language

The AI matches the customer's first message. If a customer wrote in
English but the AI is replying in Spanish, the AI may have misread an
early signal (a name, a place, a phrase).

- Take over the chat, say "Let me continue in English" in English. The
  AI follows your lead from the next message.
- If this happens often, edit your persona's instructions to default
  to a specific language. See [Personas](./04-personas).

## Branding and custom domain

### My custom domain is stuck on "Pending"

If a custom domain you added stays on **Pending** for more than 10
minutes:

1. Confirm the CNAME record at your DNS registrar points to
   `cname.vercel-dns.com`. The hostname must be exactly the name you
   typed in **Branding**.
2. Wait a few minutes — DNS propagation usually completes in 5–15
   minutes but can take up to 24 hours.
3. On the domain detail page in **Branding**, click **Re-verify**.
4. Still stuck after 24 hours: **Report a bug** with the domain name and
   a screenshot of the CNAME record from your registrar.

### My logo looks blurry or cut off

- Re-upload at 512×512 pixels minimum. Smaller logos get upscaled and
  look fuzzy.
- For wide horizontal logos, use the **Wide logo** slot instead of the
  square logo. The square slot is for favicons and chat-bubble icons.
- PNG with a transparent background looks cleanest. JPG with a white
  background is fine too. Avoid GIF.

### Outbound emails are coming from the platform address instead of mine

Your custom email-from domain hasn't finished verifying. Open
**Branding → Email settings**, check the verification status, and follow
the DNS-record instructions. Until the domain is verified, the platform
falls back to the platform sender so emails still get through.

## Billing

### My subscription invoice didn't generate

Stripe handles invoice generation. If an expected invoice didn't appear:

1. Confirm in **Billing** that your subscription status is **active**.
2. Check your Stripe Customer Portal for the invoice — it may have
   generated there.
3. If the subscription went to **past due**, follow the Stripe-emailed
   link to update the payment method.
4. Persistent issues: **Report a bug** and include your Stripe customer
   ID (visible at the top of **Billing**).

### I want to change my tier

Open **Billing → Subscription → Change plan**. Upgrades take effect
immediately and are prorated on your next invoice. Downgrades take
effect at the end of the current billing period so you don't lose paid
days.

### A charge looks wrong

Open the invoice from **Billing → Invoice history**. The line items
break down what you were charged for. If something still looks wrong,
email support with the invoice ID — don't dispute the charge with your
card issuer first; that locks the account.

## CRM and customers

### I can't find a customer I added

- Check the search bar at the top of **CRM → Customers** — search is
  fuzzy and tries email, name, and phone.
- Filters at the top of the list may be excluding them (e.g., "Active
  only" hides archived customers).
- If you added them as an anonymous lead, they live under
  **CRM → Leads**, not Customers, until you convert them.

### I deleted a customer by mistake

Go to **CRM → Customers → Archived**. Soft-deleted customers stay
recoverable for 30 days. Click the customer, then **Restore**. After
30 days, the customer is purged per privacy law and can't be recovered.

### I made a typo in our company name

Open **Settings → Business identity → Edit**. The legal name field is
editable any time. Be aware: changes to the legal name appear on
*future* invoices and customer emails — past records keep the name that
was in effect at the time.

## RAG content and knowledge

### A document I uploaded isn't showing up in AI answers

- Open **CRM → Knowledge** and find the document. Check its status:
  - **Processing** — give it 5–10 minutes
  - **Needs review** — open it, confirm or edit the AI's summary, then
    click **Approve**
  - **Rejected** — read the rejection reason; usually it means the file
    couldn't be parsed (scanned PDF without OCR, or password-protected)
- Even an approved document may take up to 24 hours to fully index.
  After that, ask your concierge a question that should hit it; if you
  still get the wrong answer, **Report a bug** with the document name.

### The AI keeps quoting outdated prices

You probably have an old price sheet still indexed. In **Knowledge**,
find the old document and click **Archive**. Upload the new one. Within
an hour the AI will use the new prices.

## When to email support vs. when to report a bug

- **Report a bug** when something *looks broken* — a page won't load,
  a button doesn't respond, a number doesn't add up, the AI did
  something it shouldn't. The Report-a-bug form captures all the
  technical context engineering needs.
- **Email support** when you need help *deciding* — choosing a tier,
  interpreting a policy, planning a migration. Humans answer these.

## Persistent or urgent issues

If a problem is blocking you from working — you can't sign in, billing
is broken, the chat surface is fully down — email support directly. The
inbox is monitored, and urgent items get same-day response.
