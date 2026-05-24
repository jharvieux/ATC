---
title: Troubleshooting
slug: troubleshooting
order: 12
category: ops
---

# Troubleshooting

<!-- TODO(content): operator content — fill out per real production failure
modes. The 4 sections below are scaffold structure so the docs viewer
exercises the rendering path end-to-end. -->

## Custom domain stuck on "Pending"

If a custom domain you added stays on "Pending" for more than 10 minutes:

1. Confirm the CNAME record at your DNS registrar points to
   `cname.vercel-dns.com`.
2. Verify the record by running `dig <yourdomain>` from a separate network.
   DNS propagation can take up to 48 hours but usually completes in minutes.
3. Trigger a manual re-verification by clicking **Re-verify** on the domain
   detail page in `/admin/branding`.
4. If still pending after 24 hours, **Report a bug** with the domain name
   and the DNS record screenshot.

## A customer can't see the chat widget

If a customer reports they don't see the chat surface on your site:

1. Check that the customer is on your branded subdomain (not the platform
   root).
2. Confirm the customer hasn't been hard-blocked under §27 abuse controls
   — check `/admin/abuse-monitoring` for their identifier.
3. If the customer is on a corporate network, the network may block the
   chat surface's WebSocket connection. The widget falls back to long-polling
   but some networks block that too.

## Subscription invoice didn't generate

Stripe handles invoice generation. If an expected invoice didn't appear:

1. Confirm in `/admin/billing` that your subscription status is `active`.
2. Check Stripe Customer Portal for the invoice; it may have generated there.
3. If the subscription went to `past_due`, follow the Stripe-emailed link
   to update the payment method.
4. Persistent issues — **Report a bug** and include your Stripe customer
   ID (visible in `/admin/billing`).

## AI gave a customer wrong information

Per §10 the supervisor catches most factual errors, but some slip through.
When a customer reports a wrong answer:

1. Open the affected conversation in `/admin/conversations`.
2. Use the **Mark as bad answer** button on the offending message.
3. The platform's eval harness will re-score the persona's behavior on
   similar inputs.
4. If the AI committed to a price, date, or booking detail that the
   customer holds the platform to: that's a §10 contract-formation event
   — escalate to a human agent immediately and **Report a bug** so engineering
   can review the supervisor finding.
