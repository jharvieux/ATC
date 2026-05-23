# Cookies inventory

Reference list of cookies set by the AI Travel Concierge platform. Per spec §25.8 this inventory is operator-maintained and must enumerate every cookie set by every subdomain or third-party integration in production.

## Status: stub

TODO(operator): populate the tables below with the actual cookies emitted by each subsystem after Phase 1 launch and after any new integration is added.

## Categories

| Category | Default | Purpose | Spec |
|---|---|---|---|
| Essential | always on, non-toggle | Session, security, basic preferences | §25.8 |
| Performance | opt-out (on by default) | Analytics, usage telemetry | §25.8 |
| Marketing | opt-in (off by default) | Cross-site retargeting | §25.8 |

## Cookies (operator to fill)

| Name | Domain | Category | Set by | Purpose | Max-Age |
|---|---|---|---|---|---|
| `cookie_preferences` | platform parent | Essential | First-party (CookieConsentBanner) | Stores user's category choices | 1 year |
| `atc-anon-session` | tenant subdomain | Essential | Chat backend (BP24) | Anonymous chat session correlation | session |
| `sb-...` (Supabase auth) | platform parent | Essential | `@supabase/supabase-js` | Authenticated session | session |
| _add more here_ | | | | | |

## Review cadence

- Annual review via the `subprocessors-annual-review` Inngest cron.
- Update on any new third-party integration or analytics provider.
