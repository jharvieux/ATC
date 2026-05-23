# Feature flags & operational toggles

**Owner:** platform operator
**Spec refs:** §28.15, §10.6 (kill switch), §27 (abuse toggles)
**Audience:** anyone flipping a runtime toggle on the platform

Not every toggle is an env var. Some live in the `platform_settings` table
because they need to change without a redeploy, and some are per-tenant in
`tenant_settings`. This catalog tells you which to change and how.

## Env-var toggles (flip = redeploy)

These live in the Zod schema (`apps/main/src/lib/env.ts`). Changing them
requires a Vercel env-var update **and** a redeploy.

| Env var | Default | Effect when changed | Spec |
|---|---|---|---|
| `AI_GLOBAL_KILL_SWITCH` | `false` | Refuse every Anthropic call platform-wide. Returns the §10.6 fallback message. **Emergency stop.** | §10.6 / §28.15 |
| `RAG_INGESTION_PAUSED` | `false` | Reject new RAG submissions; the ingest cron sleeps. | §28.15 |
| `MAINTENANCE_MODE` | `false` | Routing middleware serves the maintenance banner page instead of the app. | §28.15 |
| `SIGNUP_ENABLED` | `true` | Hides public sign-up routes. Existing tenants unaffected. | §28.15 |
| `STRIPE_CONNECT_ONBOARDING_ENABLED` | `true` | Pauses new Connect onboarding; existing Sub-Host tenants unaffected. | §28.15 |
| `OAUTH_GOOGLE_ENABLED` | `true` | Removes the Google sign-in button. | §28.9 |
| `OAUTH_MICROSOFT_ENABLED` | `true` | Removes the Microsoft sign-in button. Disabling **also** removes the MS-Graph creds requirement (superRefine). | §28.9 / §17.2 |
| `OAUTH_FACEBOOK_ENABLED` | `true` | Removes the Facebook sign-in button. | §28.9 |
| `OAUTH_APPLE_ENABLED` | `false` | Deferred per §17.1; flip to enable when Apple integration is wired. | §28.9 |
| `ANTHROPIC_PROMPT_CACHE_ENABLED` | `true` | Debug switch — disables prompt-caching on Anthropic calls. | §28.5 |
| `ABUSE_OVERRIDE_REQUIRE_REAUTH` | `true` | When `false`, the platform-admin override flow skips the 4h re-auth gate (§26.3). Loosens security; document if disabled. | §28.17 |
| `STAGING_MODE` | `"false"` | When `"true"`, outbound emails redirect to `TEST_OVERRIDE_EMAIL` and certain crons short-circuit. **Never set in production.** | §25.10 / BP25 |

**To change**: Vercel → Settings → Environment Variables → edit per-env, redeploy.

## DB-backed toggles (flip = SQL update, no redeploy)

These live in `platform_settings` (key/value) or `tier_definitions` and take
effect within seconds — the consuming code reads them fresh on each request
(or per cache TTL).

| Setting | Surface | Effect |
|---|---|---|
| `platform_settings.ai_pricing_catalog` (JSONB) | Operator UI / direct SQL | Overrides the default Anthropic/OpenAI pricing constants used by abuse-cost attribution (§27.12). |
| `platform_settings.abuse_notification_copy` (JSONB) | Operator UI | Per-(dimension, state) subject + body template for state-transition emails (§27.8 / BP28). |
| `platform_settings.supervisor_slur_deny_list` (TEXT[]) | Operator-loaded (per BP24 follow-up) | Forum + chat slur match patterns. |
| `platform_settings.host_agency_name` (TEXT) | Operator UI | Hard-coded host agency name shown to BYO tenants. |
| `tier_definitions` (table) | SQL migration | Per-tier base seat price, chat caps, RAG caps. Changing these takes effect on the next request. |
| `tenant_usage_overrides` (table) | Platform-admin UI | Per-tenant cap overrides for the §27 abuse dimensions. |
| `tenant_settings.email_paused_due_to_bounce_rate` (BOOL) | Cron (`email-bounce-rate-monitor`) | Auto-set when a tenant exceeds the §27.4.4 bounce-rate threshold; cleared on operator review. |
| `users.memory_opt_out` (BOOL) | User UI | Customer opts out of memory extraction (§11.3 / BP12). |

**To change**: SQL `UPDATE platform_settings SET value = … WHERE key = …` (with
appropriate audit) or via the operator console UI.

## Per-tenant toggles (live in `tenants` / `tenant_settings`)

| Setting | Effect |
|---|---|
| `tenants.is_active` | Tenant-wide hard pause. |
| `tenants.tier` | Sub-Host vs BYO tier (drives §27.4 thresholds). |
| `tenant_settings.persona_tone_max_level` | Per-tenant override of `PERSONA_TONE_DEFAULT_MAX_LEVEL`. |
| `tenant_settings.email_send_pattern` | `platform_resend` (Pattern B) vs `tenant_resend` (Pattern A). |

## Cron schedules (env-var)

| Env var | Default | Cron path |
|---|---|---|
| `ABUSE_RECOMPUTE_CRON_SCHEDULE` | `0 3 * * *` | BP28 — nightly abuse recompute |

Other crons have schedules hard-coded in the Inngest function definitions.

## Numeric thresholds (env-var, percent-based)

| Env var | Default | Spec |
|---|---|---|
| `ABUSE_AI_COST_SOFT1_PERCENT` | 30 | §27.4 |
| `ABUSE_AI_COST_SOFT2_PERCENT` | 50 | §27.4 |
| `ABUSE_AI_COST_HARD_PERCENT` | 70 | §27.4 |
| `ABUSE_RAG_APPROACHING_PERCENT` | 85 | §27.4 |
| `ABUSE_EMAIL_BOUNCE_RATE_THRESHOLD_PERCENT` | 5 | §27.4.4 |
| `ABUSE_RAG_PROMOTION_BONUS_PER_CHUNK` | 25 | §27.4.2 |
| `ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS` | 30 | BP28 |
| `CUSTOMER_CHAT_SOFT1_CAP` / `SOFT2_CAP` / `HARD_CAP` | 20 / 30 / 40 | §24.9 |
| `RAG_CHUNK_CONFIDENCE_FLOOR` | 0.35 | §21.3 |

Changes require redeploy. Most are deliberately tunable for ops without a code change; defaults match the §27 / §24 / §21 specs.

## When in doubt

If a toggle is needed in production and isn't listed here, ask before adding
a new env var. Adding a new operational toggle requires:
- Schema entry in `apps/main/src/lib/env.ts` with a sensible default.
- `.env.example` entry under the right `§28.x` group.
- Update to this runbook.
- If the toggle controls AI behavior or billing, a MEMORY.md entry.
