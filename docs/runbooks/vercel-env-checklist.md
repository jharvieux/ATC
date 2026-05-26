# Vercel env-var checklist — atc-main (preview + production)

Generated 2026-05-26. Compares what `apps/main/src/lib/env.ts` requires at boot against what is actually configured in the Vercel project `atc-main` (team `jharvieux-1491s-projects`).

**Why this exists:** the Vercel project has never produced a successful deploy. `vercel env ls` shows 12 variables, of which 10 are stored with empty-string values and ~16 more required vars are missing entirely. This checklist drives the remediation.

**Operator decision (2026-05-26):** preview will point at the same Supabase project as production. The "Set in" column reflects that — both environments need the same values.

---

## A. Variables currently in Vercel with EMPTY values (8) — set these first

Per the Vercel UI, "Edit Variable" → paste value → Save (or `vercel env rm KEY preview && vercel env add KEY preview`).

| Variable | What to provide | Source |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase project URL (`https://<ref>.supabase.co`) | Supabase dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production Supabase anon key | Supabase dashboard → Project Settings → API → Project API keys → `anon public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Production Supabase service-role key | Supabase dashboard → Project Settings → API → Project API keys → `service_role` (⚠️ secret) |
| `ANTHROPIC_API_KEY` | Real `sk-ant-...` key | console.anthropic.com → API Keys |
| `OPENAI_API_KEY` | Real `sk-...` key | platform.openai.com → API keys |
| `RESEND_API_KEY` | Real `re_...` key | resend.com → API Keys |
| `AGENCY_EMAIL` | Operator notification address | Decide — used by `sendOperatorAlert` |
| `CRON_SECRET` | Long random string for Vercel cron auth | `openssl rand -hex 32` |

Set each in **both Preview and Production** environments.

---

## B. Variables REQUIRED by env.ts but MISSING from Vercel (16) — must be added before any deploy boots

These will fail `verifyEnvAtBoot()` with "Missing or invalid environment variables".

| Variable | What to provide | Generate with |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (preview) or `sk_live_...` (production) | Stripe dashboard → Developers → API keys |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` or `pk_live_...` | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` for the main webhook endpoint | Stripe dashboard → Webhooks → endpoint → Reveal secret |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_...` for the Connect webhook endpoint | Stripe dashboard → Connect → Webhooks |
| `SERVICE_JWT_PRIVATE_KEY` | Ed25519 private key (PEM) used to sign service→service JWTs | `openssl genpkey -algorithm Ed25519 -out priv.pem && cat priv.pem` |
| `SERVICE_JWT_KEY_ID` | Short string identifier for the key above | `v1` |
| `RAG_SERVICE_URL` | URL of the deployed RAG service (atc-rag) | Vercel atc-rag production URL once that project is also deployed |
| `RAG_WEBHOOK_SECRET` | Shared HMAC secret between main↔RAG | `openssl rand -hex 32` |
| `APP_ENCRYPTION_KEY_CURRENT` | 256-bit base64 key for credential encryption | `openssl rand -base64 32` |
| `APP_ENCRYPTION_KEY_ID_CURRENT` | Short identifier | `app-v1` |
| `INVITATION_TOKEN_HMAC_KEY` | 256-bit base64 key for invitation-token HMAC | `openssl rand -base64 32` |
| `PLATFORM_PEPPER` | **Generated ONCE at platform genesis. NEVER rotate** — rotation breaks every customer hash. 256-bit base64. | `openssl rand -base64 32` (write it down separately) |
| `FORENSICS_ENCRYPTION_KEY_CURRENT` | 256-bit base64 key. **MUST differ from APP_ENCRYPTION_KEY_CURRENT** (§26.5a boot guard checks this) | `openssl rand -base64 32` |
| `GITHUB_APP_ID` | Numeric ID of the GitHub App used for §32 Self-Service Help issue creation | github.com → Settings → Developer settings → GitHub Apps |
| `GITHUB_APP_PRIVATE_KEY` | PEM-format private key for the same GitHub App | github.com app settings → Generate a private key |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID of the app on this repo | github.com app settings → Install App → URL contains the ID |
| `GITHUB_REPO_OWNER` | Repo owner — `jharvieux` | literal |
| `GITHUB_REPO_NAME` | Repo name — `ATC` | literal |

Note: `GITHUB_APP_PRIVATE_KEY` is multi-line; in Vercel UI paste the entire PEM including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` markers. Newlines preserved.

---

## C. Already set with real values (don't touch) — 4

These are configured correctly.

| Variable | Notes |
|---|---|
| `PLATFORM_PRIMARY_DOMAIN` | ✓ |
| `PLATFORM_DOMAIN_REGEX` | ✓ |
| `INNGEST_EVENT_KEY` | ✓ (Preview only — also needs Production scope) |
| `INNGEST_SIGNING_KEY` | ✓ (Preview only — also needs Production scope) |

⚠️ The two Inngest vars are scoped to Preview only. Production needs them too — duplicate or change the scope.

---

## D. Optional vars worth setting (call sites tolerate absence, but features won't work)

| Variable | When to set | Generate / Source |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | When emailing links to users. Production should be your custom domain; preview can stay empty. | `https://ai-travelconcierge.com` (or your domain) |
| `RESEND_FROM_DOMAIN` | When sending email via Resend | The verified sending domain |
| `RESEND_FROM_ADDRESS_DEFAULT` | Pattern-B default From | `noreply@<RESEND_FROM_DOMAIN>` |
| `RESEND_WEBHOOK_SECRET` | When wiring Resend bounce/complaint events | Resend dashboard → Webhooks |
| `OPERATOR_ALERT_EMAIL` | Distinct from `AGENCY_EMAIL` if you want platform-ops alerts separated | your address |
| `SUPABASE_DB_URL` | Migration role connection — needed by `pnpm db:migrate` in CI | Supabase → Settings → Database → URI (use service role) |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` | If using Sentry | sentry.io project settings |
| `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` | Required only if exercising §16 white-label custom-domain features | vercel.com → Settings → Tokens |
| `STRIPE_PRICE_*` (16 of them) | Pricing — required per plan but loaded at call time, not boot. See §14/§15. | Stripe dashboard → Products → each price ID |
| `MICROSOFT_GRAPH_CLIENT_ID` / `_SECRET` | Required if `OAUTH_MICROSOFT_ENABLED=true` (which is the default) | Azure AD app registration |
| `APIFY_API_TOKEN` | Required when `APIFY_ADAPTER_ENABLED=true`. Adapter ships off by default. | apify.com → Settings → Integrations |
| `CRUISEMAPPER_DIY_USER_AGENT` | Required when `CRUISEMAPPER_DIY_INGEST_ENABLED=true`. Format: `AI-Travel-Concierge-RAG-Ingest/1.0 (+mailto:ops@…)` | literal |

---

## E. After populating

1. Re-run from `apps/main/`:
   ```
   rm -rf .vercel/.env.preview.local .next
   vercel pull --environment=preview --yes
   vercel build
   vercel deploy --prebuilt
   ```
2. Watch the deploy log — `verifyEnvAtBoot()` runs in the instrumentation hook on every cold start and will list every remaining missing/invalid var in a single error if anything is still wrong.
3. If `OAUTH_MICROSOFT_ENABLED=true` (default) and Microsoft Graph creds aren't set, the boot will fail with a clear message — flip `OAUTH_MICROSOFT_ENABLED=false` in Vercel as a quick unblock.

---

## F. atc-rag project (separate Vercel project)

The RAG service has only `PLATFORM_PRIMARY_DOMAIN` configured. Its env schema (`apps/rag/src/lib/env.ts`) needs reviewing for required vars before that project can deploy. Out of scope for this checklist — file a follow-up.
