---
title: Branding
slug: branding
order: 3
category: setup
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Branding

> **Available on:** all tiers. Some advanced controls (hiding the
> "Powered by" message, custom domain) require Pro or above.

The Branding page is where you tell the platform how your concierge
should look to customers. Most tenants set up branding once and
forget it.

Open **Settings → Branding**.

## What you control

### Logos and favicon

Three URL fields:

- **Light-mode logo URL** — the one customers see by default.
- **Dark-mode logo URL** — used when the customer's browser is in dark
  mode. If you don't have a dark version, paste the same URL as light.
- **Favicon URL** — the tiny icon in the browser tab.

> The platform does not host your image files. Upload them somewhere
> public — your existing website, Cloudinary, S3 with a public URL,
> Google Drive with a shareable link — and paste the URL here.

[Screenshot: Branding page with the three logo URL fields filled in]

### Colors

Three colors as hex codes (`#2563EB` for example):

- **Primary** — main brand color, used for headers, buttons, links.
- **Secondary** — supporting color for backgrounds and subtle accents.
- **Accent** — used sparingly for highlights and call-to-action emphasis.

The color picker lets you click a swatch to pick visually. If you don't
know your brand colors, ask whoever made your website logo — they
usually have a brand sheet.

### Font family

A CSS font stack. The default — `Inter, system-ui, sans-serif` — looks
clean on all devices and is what we recommend unless you have a strong
brand font.

### Slogan

A single line (200 characters max) shown under your logo on the
concierge home page.

### About text

Up to 2000 characters introducing your business to customers. Shown on
the concierge home page below the slogan.

## Outbound email

Two patterns:

- **Platform send (default)** — emails go from our Resend account on
  your behalf. Simple to set up; the "from" address shows your domain
  but with `via ai-travelconcierge.com` in some inboxes.
- **Your own Resend account** — emails go from your Resend account
  using your verified domain. Cleaner branding; requires you to have a
  Resend account and add the domain there yourself.

Most tenants stick with platform send for the first six months.

[Screenshot: Branding page showing the Outbound email section with the radio buttons]

### From-fields

- **Domain** — the part after the `@` in your from-address.
- **Address local part** — the part before the `@` (e.g., `hello`).
- **Display name** — the human-readable name shown to recipients
  (e.g., "Acme Travel").

## Custom domain

By default your concierge lives at `<your-slug>.ai-travelconcierge.com`.
If you want it at `concierge.yourdomain.com` instead:

1. Click the email link on the Branding page.
2. Tell us the domain you want.
3. We email you DNS instructions (add a `CNAME` record at your domain
   registrar).
4. Once DNS is verified, we provision an HTTPS certificate
   automatically.

> Custom domain setup typically takes 1 business day end-to-end.

## "Powered by" attribution

> **Available on:** all tiers — but Starter, BYO Research, and BYO
> Professional must show it; the toggle is disabled on those tiers.
> Pro, Agency, and BYO Agency can hide it.

When the toggle is on, customers see "Powered by AI Travel Concierge"
at the bottom of every concierge page. When off, the line is removed
entirely.

## Saving and previewing

Click **Save changes** at the bottom of the page. Changes go live
immediately for new customer sessions; existing customer sessions pick
up the new branding within five minutes.

To preview your branding without affecting customers:

1. Open your concierge URL in a private browser window.
2. Go through a sample conversation as a customer would.
3. If you notice issues, edit and save again.

See [Troubleshooting](./12-troubleshooting) for what to do if a custom
domain stays stuck on "Pending".
