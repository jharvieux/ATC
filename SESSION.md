# Session state — last updated 2026-06-09 18:00 CT

## Just completed
- **PR #896 merged + deployed — Inngest cost containment (D-192).** Kill switches now unregister cron functions from serve() (handler guards alone still billed an execution per tick): BOOKING_CRONS_DISABLED covers the original 6 + pre-cruise schedulers + booking-commission-retention-purge; new SUBHOSTING_CRONS_DISABLED covers the 2 custom-domain crons. Schedule stretch: task-reminders-fire 1m→5m, vendor-health-probe 1m→15m, six functions 5m→15m (monitor lookback windows widened to match). Both flags set `true` in Vercel prod; atc-main redeployed post-flag, atc-rag deployed manually.
- Issue #894 updated with corrected dashboard math (billing is executions ≈ 2× runs; no event-driven gap — crons are ~95% of usage). #899 created (Vercel Pro upgrade, blocks #894). #900 created (task-reminders-fire BATCH_LIMIT drain loop).

## In flight
- Nothing in flight — clean checkpoint. dev = PR #896 squash merge.

## Next step
- **User: upgrade Vercel Hobby → Pro (#899)**, then start the #894 migration (move vendor-health-probe, task-reminders-fire, the 3 monitors, openai-embedding-reconcile to Vercel cron routes; restore task reminders to 1-min cadence there).
- **User: verify in the Inngest dashboard** that the 9 gated functions show as archived (payouts-*, bookings-stuck-submitting-reconcile, reconcile-statement-automated, pre-cruise-email-scheduler-t1/multiphase, booking-commission-retention-purge, custom-domain-reverify, custom-domain-txt-grace-sweep), and that daily executions drop to ~3.2k by June 11.

## Blocked on user
- #899 Vercel Pro upgrade (dashboard action) — blocks #894.
- Inngest dashboard verification above (serve endpoint introspection is auth-gated; couldn't confirm archival from CLI).

## Open questions
- Expected Inngest pace after this change: ~95k executions/month — still ~2× the 50k plan until #894 lands (~40-45k/month projected). If the June bill matters, #894 is the remaining lever.
- Prior session items still open: #890 (inbound replies to persona address), #885 (Playwright lightbox test), #881 (CustomerContextChatPanel raw markers), #889 prod browser-verify (email arrival) still unconfirmed by user.
