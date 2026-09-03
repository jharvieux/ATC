# AI Travel Concierge

pnpm monorepo — two Next.js 14 apps sharing a TypeScript/ESLint/Prettier config.

## Prerequisites

- Node.js 24.x (via nvm: `nvm use 24`)
- pnpm 11.x (`brew install pnpm`)
- Supabase CLI (`brew install supabase/tap/supabase`)
- Stripe CLI (`brew install stripe/stripe-cli/stripe`)

## Repo structure

```
apps/
  main/     — customer-facing platform (Next.js 14, shadcn/ui)
  rag/      — RAG ingestion and retrieval service (Next.js 14, no UI)
packages/
  config/         — shared tsconfig, eslint, prettier
  shared-types/   — types used across both apps
scripts/          — one-shot operational scripts
tests/            — cross-cutting security and contract tests
docs/             — runbooks, design docs, eval harness design
db/               — RLS policy snapshot
.github/workflows/ — CI/CD pipeline
```

## Running locally

```bash
pnpm install
cp .env.example .env.local   # fill in values

# Run both apps (separate terminals)
cd apps/main && pnpm dev     # http://localhost:3000
cd apps/rag  && pnpm dev     # http://localhost:3001
```

## Adding a new environment variable

1. Add the variable to `.env.example` with a comment.
2. Add it to the relevant app's `src/lib/env.ts` Zod schema.
3. Run `pnpm typecheck` to verify.
4. See spec §28 for the full env-var policy.

## CI

Every PR into `dev` or `release/*` runs lint, typecheck, and build via `.github/workflows/ci.yml`.

## License

Copyright © 2026 John Harvieux. All rights reserved.

This repository contains proprietary source code. Except for the limited rights
required by the GitHub Terms of Service for a public repository, public
availability does not make the code open source or grant permission to use,
copy, modify, distribute, deploy, host, commercialize, or create derivative
works from it. See the [LICENSE](LICENSE) for the complete notice.
