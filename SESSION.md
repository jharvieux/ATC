# Session state — last updated 2026-05-22 20:05 UTC

## Just completed
- BP23: Email infrastructure, pre-cruise series, in-app notifications (§23) — PR #69 merged to dev
  - Migration 20260602000000_email_notifications.sql: email_log (full §23.2 replacing BP19 4-col stub), email_suppressions, pre_cruise_email_content, port_info_chunks (17 NA ports), notifications
  - sendEmail() helper: suppression check + rate limit + Pattern A/B Resend key resolution
  - Rate limit: transactional unlimited, marketing 4/month, travel_news 1/week
  - CAN-SPAM unsubscribe token + endpoint + /email/unsubscribe-confirmed page
  - Resend webhook handler (delivered/soft_bounce/hard_bounce/complained/engagement)
  - Pre-cruise templates: T-90/T-30/T-7/T-1 (T-1 has hardcoded carry-on essentials callout)
  - Pre-cruise scheduler cron (hourly) + precruiseGenerateAndSend Inngest function (Haiku content gen)
  - Soft bounce retry: +6h/+12h/+24h attempts, exhaustion → hard bounce + suppress
  - In-app notifications: createNotification() helper, mark-read, dismiss endpoints
  - Companion page /companion/[token] (HMAC-gated, reads pre_cruise_email_content JSONB)
  - Gmail inbound stub + docs/runbooks/gmail-inbound-setup.md
  - 4 test files, 21 tests; all 439 tests passing; CI all checks green
  - Key fix: removed static react-dom/server import from send.ts; buildEmail() uses dynamic import

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Start BP24: Chat UI (§24) — switch to Opus 4.7 per build prompt

## Blocked on user
- Nothing

## Open questions
- Port info content: 17 ports in port_info_chunks all have NULL content fields — operator must populate
- Weather integration deferred (TODO(weather-integration)) — no weather API selected
- Gmail inbound setup requires operator action per docs/runbooks/gmail-inbound-setup.md
- Operator tasks for BP23 (not code):
  - Apply migration 20260602000000_email_notifications.sql to atc-main
  - Set RESEND_WEBHOOK_SECRET in Vercel
  - Point Resend webhook URL to https://<domain>/api/webhooks/resend
  - Populate port_info_chunks content (17 ports, all NULL currently)
  - Optionally set COMPANION_TOKEN_HMAC_KEY in Vercel (falls back to INVITATION_TOKEN_HMAC_KEY)
- Carry-over from prior BPs: audit_log real-INSERT swap, slur deny-list, BrandedLayout, contacts FK, etc.
