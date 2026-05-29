# Local development — environment setup

**Owner:** new contributors + platform operator
**Spec ref:** §28.21

## TL;DR

```sh
cp apps/main/.env.example apps/main/.env.local
cp apps/rag/.env.example apps/rag/.env.local
# fill in values per the sections below
pnpm install
pnpm dev
```

The boot-time `verifyEnvAtBoot()` (§28.19) check ensures `pnpm dev` fails
loudly on misconfiguration — no surprises in production.

## Canonical references

- **Schema (truth):** `apps/main/src/lib/env.ts`, `apps/rag/src/lib/env.ts`.
- **Example mirror:** `apps/main/.env.example`, `apps/rag/.env.example`.
- **Audit:** `docs/env-audit.md` — spec vs code cross-reference.
- **Rotation:** `docs/runbooks/secret-rotation.md`.
- **Stripe price-IDs:** `docs/runbooks/stripe-price-ids.md`.
- **Feature flags:** `docs/runbooks/feature-flags.md`.

## What you need

| Resource | Recommendation |
|---|---|
| **Supabase project** | Your own shadow project on the Free tier. Reset frequently for testing. Use a separate project for the RAG service. |
| **Stripe** | Test-mode keys (`sk_test_…`, `pk_test_…`). Create a small set of test-mode `price_…` IDs covering the tiers you touch. |
| **Anthropic** | Personal API key with a monthly limit cap (Anthropic console → Settings → Usage Limits). Default `claude-sonnet-4-6` or override per-feature. |
| **OpenAI** | Personal API key with a personal monthly limit cap. Used by both RAG embeddings (required for RAG dev) and DALL-E hero images (optional). |
| **Resend** | Optional. If unset, email sends fail at the call site; many flows still work. |
| **Inngest** | Inngest Cloud account (free tier) with personal signing key, OR run the [Inngest dev server](https://www.inngest.com/docs/local-development) locally. |
| **Redis** | Local Docker (`docker run -p 6379:6379 redis`) — the RAG service requires `REDIS_URL` for jti replay protection. |

## Required env vars to actually boot

This is the **complete** set the schema (`apps/main/src/lib/env.ts`) marks as
required-at-boot. Every other variable in `apps/main/.env.example` is optional —
it has a schema default, or it fails later at its call site rather than at boot.
So the short list here is intentional, not a documentation gap (reconciled against
`env.ts` 2026-05-29, punch-list #62).

- `PLATFORM_PRIMARY_DOMAIN`, `PLATFORM_DOMAIN_REGEX`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY` (must start with `sk_test_` or `sk_live_`)
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (must start with `pk_test_` or `pk_live_`)
- `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` (must start with `whsec_`)
- `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`
- `SERVICE_JWT_PRIVATE_KEY`, `SERVICE_JWT_KEY_ID`
- `RAG_SERVICE_URL`, `RAG_WEBHOOK_SECRET`
- `APP_ENCRYPTION_KEY_CURRENT`, `APP_ENCRYPTION_KEY_ID_CURRENT`
  - Generate: `openssl rand -base64 32`
- `INVITATION_TOKEN_HMAC_KEY`
  - Generate: `openssl rand -base64 32`
- `PLATFORM_PEPPER`
  - Generate: any high-entropy string. Per §25 / D-058, **never rotate this in production**. In local dev you can change it freely.
- `FORENSICS_ENCRYPTION_KEY_CURRENT`
  - Generate: `openssl rand -base64 32` — **must differ from `APP_ENCRYPTION_KEY_CURRENT`** (§26.5a boot guard).
- `ANTHROPIC_API_KEY` (must start with `sk-ant-`)
- `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET`
  - Required when `OAUTH_MICROSOFT_ENABLED=true` (default). To skip: set `OAUTH_MICROSOFT_ENABLED=false`.
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`
  - Required since BP31 (§32.14). Used by the help-AI bug-triage flow.
  - Local dev doesn't exercise GitHub App auth — placeholder values are sufficient:
    ```bash
    GITHUB_APP_ID=0
    GITHUB_APP_INSTALLATION_ID=0
    GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
    ci-placeholder
    -----END RSA PRIVATE KEY-----"
    GITHUB_REPO_OWNER=ci-placeholder-owner
    GITHUB_REPO_NAME=ci-placeholder-repo
    ```
  - The `PRIVATE_KEY` must contain `-----BEGIN` to satisfy the zod schema's PEM-format check on `GITHUB_APP_PRIVATE_KEY` in `apps/main/src/lib/env.ts`.
  - These were added to `.github/workflows/e2e.yml` in PR #320; missing them locally is what caused the Next 14 → 16 instrumentation crash described under "When boot fails" below.

## Local-dev shortcuts

A common local-dev `.env.local` for someone not exercising Microsoft OAuth
or production keys:

```bash
OAUTH_MICROSOFT_ENABLED=false  # skip the MS Graph requirement
OAUTH_FACEBOOK_ENABLED=false   # skip Facebook button in UI
IMAGE_GEN_PROVIDER=none        # skip DALL-E key requirement
RAG_INGEST_OCR_PROVIDER=none   # skip GCV key requirement
STAGING_MODE=false             # never set 'true' outside the staging env
```

## When boot fails

`verifyEnvAtBoot()` accumulates all errors and surfaces them in one
structured message. Example:

```
Error: Environment validation failed:
  ANTHROPIC_API_KEY: must start with sk-ant-
  STRIPE_SECRET_KEY: must start with sk_test_ or sk_live_
  MICROSOFT_GRAPH_CLIENT_ID: Required when OAUTH_MICROSOFT_ENABLED=true
```

Fix all reported issues, then re-run. Boot won't continue until every
issue is resolved.

## Things you should NOT do

- Commit `.env.local` (it's gitignored — keep it that way).
- Put a real production secret anywhere except the Vercel project env vars + your password manager.
- Use the same Anthropic/OpenAI/Stripe key across multiple developers — usage attribution and rate-limiting become impossible to debug.
- Mix test-mode Stripe price IDs with live-mode `STRIPE_SECRET_KEY` (or vice versa). See `docs/runbooks/stripe-price-ids.md`.
- Set `STAGING_MODE=true` in your `.env.local` unless you specifically need to test the staging outbound-isolation path.

## Tearing down

Resetting your Supabase shadow project is the fastest way to get a clean
DB without affecting other contributors. Migrations live in
`apps/main/supabase/migrations/` and apply via `supabase db reset`.
