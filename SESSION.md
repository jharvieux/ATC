# Session state — last updated 2026-06-15 20:30 ET

## Just completed
- Fixed the "internal_error on Set Up Billing screen" bug. Root cause: `env()` threw `"env() called before verifyEnvAtBoot()"` because Next bundles `instrumentation.ts` separately from route-handler chunks, so the `_env` singleton populated at boot wasn't visible to the env.ts instance `priceIdFor → env()` imports. Fix: `env()` now lazily calls the idempotent `verifyEnvAtBoot()`.
- Improved error diagnosability: `respondToAuthError` stamps an 8-char correlation `ref` into both the 500 body and the server log; subscription page surfaces it. `tenant/billing` POST catch switched from raw `err.message` echo → `respondToAuthError`.
- Closed a latent fail-open: extracted `lib/platform-url.ts` `platformBaseUrl()` (NEXT_PUBLIC_APP_URL → PLATFORM_PRIMARY_DOMAIN → throw) and wired it into the 3 Stripe redirect routes, removing hardcoded localhost fallbacks.
- Audited the rest of onboarding/billing: webhook stage advancement + CAS-guarded state machine are correctly wired — no code bug post-payment (assuming Stripe webhooks are registered in the dashboard, which is operational).
- Added tests: env-lazy-init, respond (ref), platform-url (branches + throw).
- PR #1124 merged to dev (squash). Both audit agents clean (d091 + pre-pr, Sonnet). Beta pipeline picked it up (tag vbeta059) → deploys env() fix to prod automatically.
- Opened issue #1125 (security label) for the deferred inline DB-error-leak cleanup in tenant/billing POST.
- Logged MEMORY D-241.

## In flight
- Nothing in flight — clean checkpoint. On `dev`, up to date with origin. `apps/main/stripe-sandbox-price-ids.env` is untracked and intentionally NOT committed.

## Next step
- Confirm the env() fix resolved the prod billing error once vbeta059 finishes deploying (user re-tries "Add Payment Method" on the Set Up Billing screen). If a 500 still occurs, it now carries a `ref:` — grep prod logs for it.

## Blocked on user
- Operational confirmation (not blocking): does prod Vercel set BOTH `NEXT_PUBLIC_APP_URL` and `PLATFORM_PRIMARY_DOMAIN`, and do they differ? If yes, the connect/link + tax-form redirect host changed to NEXT_PUBLIC_APP_URL (see D-241). If NEXT_PUBLIC_APP_URL is unset in prod, no behavior change.

## Open questions
- Issue #1125: broader sweep for other routes echoing raw `*.message` from DB errors in inline 500 returns (not just tenant/billing) — left for that issue.
