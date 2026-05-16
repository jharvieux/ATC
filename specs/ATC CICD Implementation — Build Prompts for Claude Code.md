# ATC CI/CD Implementation — Build Prompts for Claude Code

Sequential build plan for the AI Travel Concierge CI/CD pipeline as specified in `ATC_CICD_Pipeline_v4_REVISED.docx`. Each section is a self-contained build prompt for an interactive Claude Code session, with model selection, manual prerequisites, the prompt itself, and verification steps.

## How to Use This Document

Each section follows the same pattern:

1. **Manual prerequisites** — steps you must complete in your browser, GitHub UI, or local shell *before* invoking Claude Code.
1. **Invocation** — the shell command to start a Claude Code session, with the model already selected.
1. **Prompt** — the text to paste into the Claude Code session after the model switches.
1. **Verification** — what to check after Claude Code finishes.
1. **Manual follow-ups** — anything that requires you to act in an external UI after Claude Code’s work is done.

**Default invocation pattern:** interactive session. Each section starts with `claude` to open Claude Code in the project directory, then `/model <name>` to switch to the right model, then paste the prompt. For narrow verification-only tasks, the doc uses one-shot invocation via `claude -p`.

**Model selection summary:**

- **Haiku 4.5** (`claude-haiku-4-5`) — fast/cheap lookups, file listings, simple text manipulation. No judgment calls.
- **Sonnet 4.6** (`claude-sonnet-4-6`) — the bulk of build work. TypeScript, SQL, YAML, Vitest harnesses, Dependabot config.
- **Opus 4.7** (`claude-opus-4-7`) — used in two places only: the deploy.yml workflow composition (§4) and the AI eval harness design (§12). Both end with a switch back to Sonnet.

**Per your standing instruction:** every Opus section ends with `/model claude-sonnet-4-6` to return to Sonnet for subsequent work.

**Before you start:** clone the AI Travel Concierge repository locally and `cd` into it. All `claude` invocations assume your current directory is the repo root.

-----

## Section 1 — Repo Structure & Branch Model

**Model:** Sonnet 4.6
**Why Sonnet:** routine file/branch inspection and config updates; no deep reasoning needed.

### Manual prerequisites

1. Confirm the repository exists on GitHub and you have admin access.
1. In GitHub web UI: Settings → Branches → Default branch — set `dev` as the default branch if it isn’t already.
1. In GitHub web UI: Settings → Branches → Add branch protection rule on `dev`:
- Require a pull request before merging
- Require status checks to pass before merging (the specific checks will be added in §4)
- Do not allow bypassing the above settings
- No direct commits
1. In Vercel Dashboard → `ai-travelconcierge.com` → Settings → Git: remove `main` from the production branch setting. Leave `dev` branch auto-deploy enabled.

### Invocation

```bash
cd /path/to/ai-travel-concierge
claude
```

In the Claude Code session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Audit the repository state for CI/CD readiness. Do the following:

1. List the current top-level directory structure.
2. Confirm the following directories exist (create them empty with a .gitkeep
   if missing, but report this to me before doing so):
   - .github/workflows/
   - scripts/
   - supabase/migrations/
   - tests/e2e/
   - src/lib/email/
   - src/lib/twilio/
   - src/app/api/health/

3. List the current branches in the local repo. Confirm dev exists.
4. Identify which file currently defines the build/deploy workflow, if any.
5. If any .github/workflows/*.yml file exists, summarize what it does.
6. Report whether package.json has scripts for: typecheck, lint, test, build.
   If any are missing, propose the script entries but do NOT modify
   package.json until I approve.

Report findings as a summary, then wait for my instructions before making
any changes.
```

### Verification

- Confirm the audit summary matches your expectation of the repo state.
- Decide which proposed changes to apply; respond in the Claude Code session.

### Manual follow-ups

- Configure GitHub branch protection rules per the prerequisites above (this cannot be done from Claude Code).
- Disable Vercel auto-deploy from `main` per the prerequisites above.

-----

## Section 2 — GitHub Environments Setup

**Model:** N/A (manual) — verification only via Haiku 4.5
**Why manual:** GitHub Environments cannot be created from Claude Code; they require the GitHub web UI or the GitHub API with appropriate auth. The verification at the end uses Haiku because it’s a simple lookup.

### Manual steps

In GitHub web UI → Settings → Environments → New environment, create the following three environments. Names are case-sensitive and must match the workflow file in §4 exactly.

1. **dev** — no protection rules, no required reviewers.
1. **staging** — no protection rules, no required reviewers (auto-promotes after E2E).
1. **production** — Required reviewers: add yourself and any other approvers.

### Verification (one-shot)

```bash
claude -p --model claude-haiku-4-5 \
  "Use the GitHub CLI (gh) to list all environments configured in this
   repository. Report each environment name and any protection rules.
   Confirm that 'dev', 'staging', and 'production' all exist (case-sensitive)
   and that 'production' has at least one required reviewer."
```

You may need `gh auth login` configured beforehand. If `gh` cannot read environments, fall back to confirming visually in the GitHub web UI.

### Manual follow-ups

None — this section is entirely manual.

-----

## Section 3 — Environment Secrets Configuration

**Model:** N/A (manual) — verification only via Haiku 4.5
**Why manual:** secrets must be entered through the GitHub web UI or `gh secret set`; the values themselves are sensitive and shouldn’t be passed to an AI session.

### Manual steps

For each environment, add the secrets listed below. Use GitHub web UI → Settings → Environments → [environment] → Add secret, or `gh secret set <NAME> --env <env>`.

**Per-environment secrets (different value per environment):**

|Secret                     |dev           |staging        |production     |Source                                          |
|---------------------------|--------------|---------------|---------------|------------------------------------------------|
|`DB_URL`                   |atc-dev DB URL|atc-test DB URL|atc-prod DB URL|Supabase Dashboard → Project Settings → Database|
|`SUPABASE_SERVICE_ROLE_KEY`|atc-dev key   |atc-test key   |atc-prod key   |Supabase Dashboard → Project Settings → API     |

**Shared environment secrets (same value all three):**

|Secret             |Source                                       |
|-------------------|---------------------------------------------|
|`VERCEL_TOKEN`     |Vercel Dashboard → Settings → Tokens → Create|
|`VERCEL_ORG_ID`    |Vercel project settings                      |
|`VERCEL_PROJECT_ID`|Vercel project settings                      |

**Staging-only secrets:**

|Secret               |Value                                         |Notes                                         |
|---------------------|----------------------------------------------|----------------------------------------------|
|`TEST_OVERRIDE_EMAIL`|Your email                                    |All outbound emails redirected here on staging|
|`TEST_OVERRIDE_PHONE`|Your phone (E.164 format, e.g. `+15555550100`)|All outbound SMS redirected here on staging   |

**Repository-level secrets (not environment-scoped):**

|Secret                     |Used by             |Value                                                              |
|---------------------------|--------------------|-------------------------------------------------------------------|
|`ANTHROPIC_API_KEY_TEST`   |CI test job, E2E job|Separate Anthropic key with a spending cap — not the production key|
|`SUPABASE_TEST_URL`        |CI test job         |atc-test project URL                                               |
|`SUPABASE_TEST_ANON_KEY`   |CI test job         |atc-test anon key                                                  |
|`SUPABASE_TEST_SERVICE_KEY`|CI test job         |atc-test service role key                                          |
|`PROD_DB_URL`              |db-copy job         |atc-prod Postgres URI (include `?sslmode=require`)                 |

### Verification (one-shot)

```bash
claude -p --model claude-haiku-4-5 \
  "Use 'gh secret list' (repository-level) and 'gh secret list --env dev',
   'gh secret list --env staging', 'gh secret list --env production' to
   list all configured secrets. Compare against this required list:

   Repo-level: ANTHROPIC_API_KEY_TEST, SUPABASE_TEST_URL,
   SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_KEY, PROD_DB_URL

   All three envs: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID,
   DB_URL, SUPABASE_SERVICE_ROLE_KEY

   Staging only: TEST_OVERRIDE_EMAIL, TEST_OVERRIDE_PHONE

   Report any missing secrets. Do not output the secret values."
```

### Manual follow-ups

- Verify in Supabase that the test/dev project has the same RLS policies as production. If they’ve drifted, plan a snapshot copy before the first release run.

-----

## Section 4 — The deploy.yml Workflow File

**Model:** Opus 4.7 — switch back to Sonnet 4.6 at the end.
**Why Opus:** the workflow file is the central nervous system of the pipeline. It chains seven jobs (CI suite, db-copy, deploy-staging with E2E, deploy-production with manual approval, smoke tests, tagging, auto-merge) with conditional execution rules, environment scoping, and secret references. Errors here cascade. Opus is worth the cost for this one file.

### Manual prerequisites

- §1, §2, §3 complete.
- `src/app/api/health/route.ts` exists and returns `{ status, timestamp, version, checks: { supabase } }`. If it doesn’t, build it first via Sonnet (see §6 for a similar wrapper-building pattern; the health endpoint is simpler — just a Next.js route handler that pings Supabase).

### Invocation

```bash
cd /path/to/ai-travel-concierge
claude
```

In the Claude Code session:

```
/model claude-opus-4-7
```

### Prompt

```
Create .github/workflows/deploy.yml for the AI Travel Concierge CI/CD
pipeline. Read the spec ATC_CICD_Pipeline_v4_REVISED.docx sections 2, 4,
5, and 6 if available in the workspace; otherwise follow this
specification exactly:

TRIGGERS:
- pull_request to branches [dev, "release/*"]
- push to branches [dev, "release/*"]

JOBS (in order, with dependencies):

1. typecheck — runs on every PR and push. Ubuntu, Node 20, npm ci,
   npx tsc --noEmit.

2. lint — parallel with typecheck. npx eslint . --max-warnings 0
   plus npx prettier --check .

3. test — parallel. Uses these secrets as env vars:
   ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY_TEST
   NEXT_PUBLIC_SUPABASE_URL = secrets.SUPABASE_TEST_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY = secrets.SUPABASE_TEST_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY = secrets.SUPABASE_TEST_SERVICE_KEY
   Runs: npx vitest run --coverage

4. secret-scan — parallel. Uses gitleaks/gitleaks-action@v2 with
   GITHUB_TOKEN from secrets.

5. db-copy — runs only on push to refs/heads/release/*. Depends on
   typecheck, lint, test, secret-scan. Installs postgresql-client.
   Steps:
   a. pg_dump from PROD_DB_URL (secret) with --no-owner --no-acl
      --format=custom to prod_dump.pgdump
   b. Terminate connections to the staging DB, then pg_restore to
      STAGING_DB_URL (which is the staging environment's DB_URL secret)
      with --no-owner --no-acl --clean --if-exists
   c. Run psql against staging with -f scripts/staging-fixups.sql

6. deploy-staging — depends on db-copy. Uses GitHub Environment "staging"
   with URL https://staging.ai-travelconcierge.com. Pulls all staging
   secrets including TEST_OVERRIDE_EMAIL and TEST_OVERRIDE_PHONE. Steps:
   a. Apply migrations: supabase db push --db-url $DB_URL
   b. Vercel deploy: vercel pull --environment=preview, vercel build,
      vercel deploy --prebuilt --target=preview
   c. Run Playwright E2E suite with BASE_URL pointing at staging URL,
      using ANTHROPIC_API_KEY_TEST. Upload playwright-report artifact
      on failure with 14-day retention.
   d. Smoke test: sleep 20, then curl -f
      https://staging.ai-travelconcierge.com/api/health
      (fail if non-200).

7. deploy-production — depends on deploy-staging. Uses GitHub Environment
   "production" with URL https://ai-travelconcierge.com. The "production"
   environment has required reviewers, so this job will pause for manual
   approval. Steps:
   a. Apply migrations to production DB.
   b. Vercel deploy with --target=production.
   c. Smoke test: sleep 30, then curl -f
      https://ai-travelconcierge.com/api/health
   d. Create release tag: extract version from branch name
      (release/X.Y.Z -> tag X.Y.Z), git tag and push.
   e. Auto-merge release/* back to dev:
      - Use gh CLI with GITHUB_TOKEN
      - Create a PR from release/* to dev with title
        "chore: merge $BRANCH back to dev" and label "release-merge"
      - Attempt gh pr merge --merge --auto
      - On conflict, print a warning with the PR URL but do NOT fail
        the workflow (use ||{ ... exit 0 })

REQUIREMENTS:
- Every job that uses npm: use actions/setup-node@v4 with cache: npm
- Every job uses actions/checkout@v4 (and fetch-depth: 0 for secret-scan)
- Use the YAML literal block syntax for multi-line shell commands
- Add section header comments to separate the CI block, db-copy block,
  staging block, and production block visually
- Verify the deploy-production job will not run on push to dev (only on
  release/*)

After generating the file, walk me through:
- The dependency graph between jobs
- Which secrets are read from which scope (repo-level vs environment)
- The conditional logic that gates db-copy on release/* only
- How the workflow handles the auto-merge conflict case without failing

Do not commit the file. I will review and commit it myself.
```

### Verification

After Claude Code generates the file:

1. Read through `.github/workflows/deploy.yml` line by line.
1. In a new one-shot session, ask Claude (Sonnet) to lint and explain:

```bash
claude -p --model claude-sonnet-4-6 \
  "Read .github/workflows/deploy.yml and report: (1) any YAML syntax issues,
   (2) any job that references a secret without specifying which scope it
   comes from, (3) any job that lacks needs: when it should have one,
   (4) whether the conditional 'if: startsWith(github.ref, ...)' is
   syntactically correct, (5) whether the auto-merge step properly handles
   merge conflicts without failing the workflow."
```

1. Manually validate with `actionlint` if installed: `actionlint .github/workflows/deploy.yml`

### Switch back to Sonnet at end of section

```
/model claude-sonnet-4-6
```

### Manual follow-ups

- Commit `.github/workflows/deploy.yml` to a feature branch.
- Open a PR into `dev` to verify the workflow runs (you’ll see typecheck/lint/test/secret-scan execute on PR open).
- Do not push to `release/*` until §5–§7 are complete.

-----

## Section 5 — DB Copy Script and Post-Restore Fixups

**Model:** Sonnet 4.6
**Why Sonnet:** SQL generation with clear requirements; Sonnet handles this well.

### Manual prerequisites

- Section 4 complete (the workflow file references `scripts/staging-fixups.sql`).
- You know the schema of `email_connections`, `agent_organizations`, and `email_messages`. If not, run `\d <table>` against the production DB read-only to confirm column names.

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Create scripts/staging-fixups.sql for AI Travel Concierge. This script
runs immediately after pg_restore copies the production database to
staging. It must prevent staging from touching live external services.

REQUIRED OPERATIONS (in order):

1. Clear Gmail OAuth tokens in email_connections:
   - Set access_token = NULL
   - Set refresh_token = NULL
   - Set connection_status = 'reconnect_required'
   - Set last_error = 'Staging: tokens cleared after DB copy from production'
   - Set last_error_at = NOW()
   - Set updated_at = NOW()
   Reason: production GMAIL_ENCRYPTION_KEY differs from staging, so tokens
   would fail to decrypt. Explicit reconnect_required is cleaner than a
   silent decryption failure and prevents the gmail-renew Inngest job from
   attempting refreshes.

2. Clear Stripe customer references in agent_organizations:
   - Set stripe_customer_id = NULL
   - Set stripe_subscription_id = NULL
   - Set updated_at = NOW()
   Reason: staging uses Stripe test-mode keys, which cannot look up
   live-mode customer IDs.

3. Suppress unprocessed customer emails in email_messages:
   - Set status = 'ignored'
   - WHERE status IN ('unread', 'triaged', 'draft_ready')
   Reason: staging should not categorize, draft replies for, or send
   responses to real production customer emails.

4. Add a verification SELECT at the end that reports counts:
   - email_connections still holding tokens (should be 0)
   - agent_organizations still holding stripe refs (should be 0)
   - email_messages still in unprocessed statuses (should be 0)
   Format as a UNION of named checks so the output is readable in
   GitHub Actions logs.

Include a comment block at the top of the file explaining what runs this
script, when it runs, and why each fixup is needed. Each UPDATE should
have a comment block above it explaining the reason.

Output the file. Do not commit it.
```

### Verification

1. Read the generated `scripts/staging-fixups.sql` and confirm the four operations are present, in order, with reason comments.
1. Test the syntax against your dev/test database first:

```bash
psql "$SUPABASE_TEST_URL" -f scripts/staging-fixups.sql --dry-run
# Or use a transaction:
psql "$SUPABASE_TEST_URL" <<'SQL'
BEGIN;
\i scripts/staging-fixups.sql
ROLLBACK;
SQL
```

1. Confirm the verification SELECT block at the end returns three rows of zero counts when run against a clean staging DB.

### Manual follow-ups

- Commit `scripts/staging-fixups.sql` to the same feature branch as `.github/workflows/deploy.yml`.

-----

## Section 6 — Outbound Override Wrappers

**Model:** Sonnet 4.6
**Why Sonnet:** TypeScript wrapper functions with a clear contract.

### Manual prerequisites

- Identify all current call sites of `resend.emails.send()` and Twilio `client.messages.create()`. The prompt asks Claude Code to do this audit, but if you already know the list, paste it in.

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt — build the wrappers

```
Implement outbound communication override wrappers for AI Travel Concierge
staging environment. Two files to create or modify, plus an audit step.

1. Create src/lib/email/send.ts:
   - Export an async function sendEmail(args: { to: string|string[],
     subject: string, ...rest }) that wraps resend.emails.send()
   - Before calling resend, check process.env.TEST_OVERRIDE_EMAIL
   - If set: replace the to field with TEST_OVERRIDE_EMAIL; prepend
     the original recipient(s) to the subject as
     [Originally to: {original}]
   - If not set: pass through unchanged
   - Re-export the function as the canonical email-sending API; nothing
     else in the codebase should call resend.emails.send() directly
   - Handle string and string[] in the to field
   - Preserve all other fields of the original args (cc, bcc, html, text,
     attachments, etc.)

2. Modify src/lib/twilio/client.ts:
   - Add or replace the SMS send function with sendSms(args: { to: string,
     body: string, ...rest })
   - Before calling client.messages.create(), check
     process.env.TEST_OVERRIDE_PHONE
   - If set: replace to with TEST_OVERRIDE_PHONE; prepend
     [Originally to: {original}] to the body
   - If not set: pass through unchanged
   - Preserve all other fields

3. Audit step — after creating/updating the wrappers, search the codebase
   for any direct calls to:
   - resend.emails.send(
   - client.messages.create( (when client is a Twilio client instance)
   - Any direct Gmail send via googleapis/gmail
   List every call site with file path and line number. For each, decide
   if it should be replaced with the wrapper. Do NOT modify call sites
   automatically — present the list for my review first.

After completing steps 1 and 2, do step 3 and present the audit results.
```

### Verification

After Claude finishes, in the same session:

```
Run the audit one more time, this time confirming that:
- Every call site listed previously now routes through sendEmail or sendSms
- No direct resend.emails.send() or client.messages.create() calls remain
  (other than inside the wrapper functions themselves)
- The wrappers handle the case where TEST_OVERRIDE_EMAIL/TEST_OVERRIDE_PHONE
  is not set without error
- The wrappers handle string[] in the to field correctly for email
```

Also run a manual test:

```bash
TEST_OVERRIDE_EMAIL=you@example.com npx vitest run src/lib/email/send
```

(You’ll need a test file; ask Claude Code to write one in the same session if it didn’t.)

### Manual follow-ups

- Review the audit list. Decide which call sites get replaced; instruct Claude Code to replace them in the same session, one batch at a time, with diffs shown before each batch.
- Commit when audit shows zero direct calls remaining.

-----

## Section 7 — E2E Test Adaptation for Real Data

**Model:** Sonnet 4.6
**Why Sonnet:** straightforward refactor with clear before/after patterns.

### Manual prerequisites

- Section 5 complete (`staging-fixups.sql` exists; you understand staging will have real prod data).
- Playwright suite exists in `tests/e2e/`. If not, this section becomes “build the E2E suite first” — out of scope for this prompt; see CI/CD doc §7.2 for the 12 flows to test.

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Update the Playwright E2E test suite in tests/e2e/ for AI Travel
Concierge. The tests now run against a copy of the production database
instead of a deterministic seed. Tests must not assume specific record
counts, specific UUIDs, or that a particular record exists. They must
assert that operations succeed and produce correct results.

ASSERTION STYLE CHANGES (find-and-replace pattern):

- toHaveLength(N) where N is a specific count
  -> length.toBeGreaterThan(0) for "should exist"
  -> length comparison with a before-state capture for "should add one"

- toBe("hardcoded-uuid")
  -> toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

- getByText("Test User Marcus") and similar hardcoded names
  -> getByRole("heading", { name: /Marcus/ }) or other partial / role-based
     selectors

- toHaveLength(5) where 5 is the expected count after creating one
  -> const before = items.length; /* action */ expect(items.length)
     .toBe(before + 1)

PROCESS:

1. List all files in tests/e2e/ and report the suite size.
2. For each test file, scan for the four pattern types above and report
   the count of each.
3. Apply the transformations in this order:
   a. UUID hardcoded values -> regex
   b. Hardcoded length assertions -> relative (before/after)
   c. Hardcoded name text -> role-based or regex selectors
   d. Hardcoded exact text matches for user-generated content -> partial

4. For any case where the test logic genuinely needs a known record (e.g.
   "as user X, verify access to resource Y"), do not transform — instead,
   flag it for me. We will solve those by creating test fixtures within
   the prod copy or by querying for an example record first.

5. After the bulk rewrite, run npx playwright test --list to confirm the
   suite still parses. Do not run the tests themselves yet — they will be
   exercised in the staging environment.

Present the changes file by file. Show me the diff for each before
applying. Don't bulk-apply.
```

### Verification

- After Claude Code finishes, run `npx playwright test --list` to confirm the suite parses.
- Manually scan a few transformed tests to ensure the assertion intent is preserved.
- The real validation happens when the workflow runs against staging — expect some failures on the first run and iterate.

### Manual follow-ups

- Commit the E2E changes to the feature branch.
- After §4–§7 are committed, push the feature branch and open a PR into `dev` to verify the CI portion of the workflow runs cleanly.

-----

## Section 8 — Required Gate §4.1.1: Dependency CVE Scan

**Model:** Sonnet 4.6
**Why Sonnet:** Dependabot config is a small YAML file; the risk-acceptance convention is policy, not code.

### Manual prerequisites

- Repo has `package-lock.json` committed (Dependabot requires the lockfile).

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Configure dependency CVE scanning for AI Travel Concierge per spec §4.1.1.

DELIVERABLES:

1. Create .github/dependabot.yml:
   - npm ecosystem, scanning package-lock.json
   - Schedule: daily
   - Open-PRs limit: 10
   - Group minor and patch updates for production dependencies
   - Group all updates for devDependencies separately
   - Labels: "dependencies", "automerge-candidate"
   - Assignees: leave empty (we'll add a CODEOWNERS rule separately)

2. Add a job to .github/workflows/deploy.yml called "cve-scan" that:
   - Runs in parallel with typecheck, lint, test, secret-scan on every PR
     and every push to dev or release/*
   - Uses npm audit --production --audit-level=critical to fail on
     critical CVEs
   - Uses npm audit --production --audit-level=high to warn (non-failing)
     on high CVEs by adding a step that runs the audit and pipes output
     to a "::warning::" annotation
   - Does NOT block on low/moderate findings

3. Create docs/security/risk-acceptance.md documenting the convention for
   suppressing a high-severity finding:
   - Open a PR adding the CVE ID and a justification to
     docs/security/cve-suppressions.md
   - The justification must include: affected package, CVE link,
     why the CVE doesn't apply to our usage, and an expiration date
     (max 90 days)
   - PR must be approved by a security reviewer (define this in
     CODEOWNERS)
   - Once merged, the next CI run will treat that CVE as accepted
   - The high-severity gate has a flag --ignore-suppressed that reads
     cve-suppressions.md and excludes matching CVE IDs from warnings

4. Stub docs/security/cve-suppressions.md as an empty (header-only) file
   with the schema documented:
   - One YAML entry per suppression: cve_id, package, reason, expires_at

Do NOT modify deploy.yml directly — show me the proposed cve-scan job
block, and I'll insert it manually in the right place (it must run after
the setup steps but in parallel with the other CI jobs).
```

### Verification

1. After Claude Code generates the files, manually insert the `cve-scan` job into `.github/workflows/deploy.yml` at the appropriate place (parallel with typecheck/lint/test/secret-scan; must be added to the `needs:` array of the `db-copy` job).
1. Open a test PR with a known-vulnerable dev dependency (e.g. an old `lodash` version) to confirm the gate fires.
1. Verify the suppressions doc workflow works: add a fake CVE ID to `cve-suppressions.md` and confirm the audit step ignores it.

### Manual follow-ups

- Add `docs/security/cve-suppressions.md` to CODEOWNERS with the security reviewer(s).
- Configure GitHub branch protection on `dev` to require the `cve-scan` check.

-----

## Section 9 — Required Gate §4.1.2: RLS Policy Snapshot Diff

**Model:** Sonnet 4.6
**Why Sonnet:** TypeScript script using Supabase admin client; reasonable complexity, no novel reasoning.

### Manual prerequisites

- Supabase service role key is available in CI as `SUPABASE_TEST_SERVICE_KEY` (per §3).
- `supabase/migrations/` directory exists and contains the migration history.

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Implement the RLS policy snapshot diff gate for AI Travel Concierge per
spec §4.1.2.

DELIVERABLES:

1. Create scripts/rls-snapshot.ts — a TypeScript script that:
   - Connects to a Supabase database using SUPABASE_URL and
     SUPABASE_SERVICE_ROLE_KEY env vars
   - Queries pg_policies for all public-schema policies (and pg_class
     to get table names and RLS-enabled status)
   - Generates a canonical SQL snapshot in this format:

     -- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
     -- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql
     -- Generated against schema: public

     -- Tables with RLS enabled:
     -- public.bookings (rls_enabled)
     -- public.users (rls_enabled)
     ...

     -- Policies:
     -- TABLE: public.bookings
     CREATE POLICY "policy_name" ON public.bookings
       FOR <command> TO <role>
       USING (<qual>)
       WITH CHECK (<with_check>);
     ...

   - Output is deterministic: tables sorted alphabetically, policies
     within a table sorted by name
   - Output goes to stdout
   - If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing, exit 1
     with a clear error

2. Create scripts/rls-snapshot-diff.ts — companion script that:
   - Regenerates the snapshot (calls the same code as snapshot.ts)
   - Reads db/rls-snapshot.sql from disk
   - Diffs them
   - Exits 0 if identical, exits 1 with a unified diff if different

3. Add npm scripts to package.json:
   - "rls:snapshot": "tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql"
   - "rls:check": "tsx scripts/rls-snapshot-diff.ts"

4. Add a job to deploy.yml called "rls-snapshot-diff":
   - Runs on every PR and every push to release/*
   - On dev pushes: runs npm run rls:check but treats failure as
     ::warning:: (informational, not blocking) — because dev can drift
     via ad-hoc changes
   - On PRs and release/*: runs npm run rls:check and fails on diff
   - Uses the dev/test Supabase instance for the snapshot query
   - Caches node_modules

5. Create db/rls-snapshot.sql with the current production RLS state.
   To populate it: run npm run rls:snapshot locally against the
   production database (read-only operation; safe). Commit the result.

6. Create docs/rls-snapshot-workflow.md explaining:
   - When the snapshot must be regenerated (every migration that touches
     RLS)
   - The regeneration command
   - How to handle a legitimate change (regenerate, commit alongside
     the migration in the same PR)
   - How to handle drift on dev that needs to be reverted

Show me each file before saving it; I'll review and approve in batches.
```

### Verification

1. Run `npm run rls:snapshot` locally against the dev Supabase (not prod) and confirm it generates output.
1. Compare the generated snapshot against the production snapshot (manually, the first time) — they should match if dev hasn’t drifted.
1. Insert the `rls-snapshot-diff` job into the workflow; verify it runs on a test PR.
1. Make a small RLS change (in a feature branch); verify the gate fires.

### Manual follow-ups

- Add `db/rls-snapshot.sql` to CODEOWNERS with database approvers.
- Add the `rls-snapshot-diff` check to branch protection on `dev`.

-----

## Section 10 — Required Gate §4.1.3: Cross-Tenant Probe Tests

**Model:** Sonnet 4.6
**Why Sonnet:** Vitest harness and Next.js route enumeration are standard patterns.

### Manual prerequisites

- Two-tenant fixtures exist per spec §30.4 (test users for tenant A and tenant B with seeded resources owned by each).
- Next.js route manifest is accessible — Next 13+ App Router exposes routes via `.next/build-manifest.json` after `next build`.

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Implement the cross-tenant probe test suite for AI Travel Concierge per
spec §4.1.3.

DELIVERABLES:

1. Create tests/security/cross-tenant-probe.test.ts:
   - Use Vitest with supertest (or fetch directly against a running
     Next.js dev server, your call — explain the trade-off and pick one)
   - Enumerate every API route under src/app/api/**/route.{ts,js}
   - For each route, for each HTTP method that route exports (GET, POST,
     PUT, DELETE, PATCH):
     - Authenticate as tenant B's user
     - Attempt the request against a resource owned by tenant A
     - For routes with path parameters (e.g. /api/bookings/[id]), use
       a resource ID owned by tenant A
     - Assert response status is one of: 401, 403, 404
     - Fail loudly on any 2xx response — that's a cross-tenant leak
     - Also fail on 5xx — server errors are not acceptable here either

2. Create scripts/enumerate-api-routes.ts:
   - Scan src/app/api/**/route.{ts,js}
   - For each file, parse the file to determine which HTTP methods it
     exports (look for export async function GET / POST / etc.)
   - Determine the route path from the file path (handle [param] and
     [...rest] segments)
   - Output a JSON manifest: [{ method, path, hasParam, paramName? }, ...]
   - The test file consumes this manifest

3. Create tests/security/fixtures/cross-tenant-setup.ts:
   - Helper that, given a fresh test Supabase instance:
     - Creates two tenants (A and B), two users (one per tenant)
     - Creates at least one resource of each type owned by each tenant
       (bookings, conversations, price_watches, quotes, etc. — list
       comes from the production schema)
     - Returns session tokens for both users and resource IDs owned by
       each tenant
   - Idempotent: safe to run multiple times

4. Add npm scripts:
   - "test:cross-tenant": "vitest run tests/security/cross-tenant-probe"

5. Add a job to deploy.yml called "cross-tenant-probe":
   - Runs on every PR (against fixtures via test:cross-tenant)
   - Runs on every release/* push (against staging — the staging has prod
     data, so this confirms cross-tenant isolation holds with real data)
   - Needs: typecheck, lint, test, secret-scan
   - On PR: uses test Supabase URL
   - On release/*: uses staging URL (waits for db-copy to complete first)
   - Fails the workflow on any unexpected 2xx or any 5xx

6. Create docs/security/cross-tenant-probe.md explaining:
   - What the test does
   - How to add a new route to the probe (usually automatic via the
     enumerator)
   - How to handle a legitimate cross-tenant route (e.g. a platform-admin
     API that's expected to access any tenant) — must be added to an
     explicit allowlist with a justification

7. Stub the allowlist: tests/security/cross-tenant-allowlist.json — empty
   array with schema comment.

Present the design plan first — especially the trade-off in #1 (supertest
against in-process app vs fetch against running dev server). Wait for
my approval before writing the test file.
```

### Verification

1. Run `npm run test:cross-tenant` locally against the dev Supabase. Expect every route to pass (return 401/403/404 for cross-tenant access).
1. As a positive control, temporarily comment out an RLS policy and confirm the probe catches it.
1. Add the `cross-tenant-probe` check to branch protection.

### Manual follow-ups

- Review the route enumerator output to confirm it caught all routes.
- For any route that’s legitimately cross-tenant (admin routes), add to `cross-tenant-allowlist.json` with justification.

-----

## Section 11 — Required Gate §4.1.4: Contract Tests for Stripe and Anthropic

**Model:** Sonnet 4.6
**Why Sonnet:** msw + vitest with recorded fixtures is well-trodden.

### Manual prerequisites

- All Stripe call sites identified (Stripe Connect onboarding, subscription create/update/cancel, customer create, payment intent flows).
- All Anthropic call sites identified (chat completions for the six personas, embeddings if used, etc.).

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Implement contract tests for Stripe and Anthropic per spec §4.1.4.

DESIGN:

- Use Vitest + msw (Mock Service Worker) for replay in PR-track tests.
- Maintain a directory tests/contracts/fixtures/ with one JSON file per
  recorded interaction, named by call site + scenario:
  - stripe/customers/create-success.json
  - stripe/customers/create-already-exists.json
  - stripe/subscriptions/create-success.json
  - stripe/subscriptions/create-card-declined.json
  - anthropic/chat/marcus-greeting.json
  - anthropic/chat/maya-pricing-question.json
  ...
- Each fixture contains: request (method, url, headers, body) and
  response (status, headers, body).
- PR-track tests configure msw to intercept calls and replay the matching
  fixture. The test then exercises the application code path and asserts
  on application behavior, not on the mock response (the mock IS the
  contract, by definition).
- Nightly canary job re-records the fixtures against real Stripe test
  mode and real Anthropic (with test API key). If the new recording's
  response schema differs from the stored fixture, fail the canary and
  open an issue.

DELIVERABLES:

1. Create tests/contracts/setup.ts — msw server setup that loads
   fixtures from tests/contracts/fixtures/.

2. Create tests/contracts/stripe/ test files for each Stripe call site
   identified. Start with: customer create, subscription create,
   subscription cancel, Stripe Connect account create, Stripe Connect
   onboarding link create. Each test:
   - Loads the relevant fixture
   - Calls the application function that wraps the Stripe SDK
   - Asserts on the application's response/side-effects

3. Create tests/contracts/anthropic/ test files for each Anthropic call
   site. Start with: one chat completion per persona (six total), one
   tool-call invocation, one streaming response.

4. Create scripts/record-contracts.ts:
   - Runs against real Stripe test mode and real Anthropic API
   - For each scenario, executes the application code with real APIs and
     records the request/response pair to the fixture file
   - Idempotent: re-running overwrites the fixtures
   - Reads STRIPE_TEST_SECRET_KEY and ANTHROPIC_API_KEY_TEST from env

5. Add npm scripts:
   - "test:contracts": "vitest run tests/contracts"
   - "contracts:record": "tsx scripts/record-contracts.ts"

6. Add a job to deploy.yml called "contract-tests":
   - Runs on every PR (replay mode, no external API calls)
   - Hard-blocks the PR if any contract test fails
   - Needs: typecheck, lint

7. Add a separate scheduled workflow .github/workflows/contracts-canary.yml:
   - Runs nightly (cron: '0 9 * * *' — 9am UTC, before working hours)
   - Re-records all fixtures
   - Compares new recordings against committed fixtures (schema-level
     diff: same keys, same types — not necessarily same values)
   - On schema drift: opens a GitHub Issue with the diff attached
     (use gh CLI)
   - Initially warning-only — set the failure step to "continue-on-error:
     true" with a clear TODO comment that this changes to a hard
     failure after the rollout period

8. Create docs/testing/contract-tests.md explaining:
   - What contracts cover (and don't — e.g. they don't catch behavioral
     regressions in the SDK, only schema changes)
   - How to add a new contract (record + commit fixture)
   - How to handle a legitimate API schema change (re-record + adjust
     application code + commit both)

Present the design (especially the msw-vs-nock choice) before writing
test files. Wait for approval. Then build incrementally: Stripe customer
create first, then I'll review before you continue.
```

### Verification

1. Run `npm run test:contracts` locally; confirm tests pass with msw replay.
1. Run `npm run contracts:record` manually once to seed the fixtures.
1. Open a test PR that breaks a contract (e.g. change the application code to expect a field that doesn’t exist in the fixture); confirm the gate fires.
1. Verify the nightly canary workflow runs by manually dispatching it.

### Manual follow-ups

- After the rollout period (you decide when — there’s no time estimate in the spec), flip the nightly canary’s `continue-on-error: true` to `false` to make it blocking. Track this in MEMORY.md.

-----

## Section 12 — Required Gate §4.1.5: AI Behavior Evaluation Harness

**Model:** Opus 4.7 — switch back to Sonnet 4.6 at the end.
**Why Opus:** the eval harness has real design trade-offs that benefit from deeper reasoning. The dimensions: scoring strategy (Claude-as-judge prompt design, multi-judge ensemble vs single), result storage schema (per-eval-run rows vs aggregated), regression detection threshold (what counts as “significantly degraded”), how to prevent eval set leakage into training data, sampling strategy for the 1% production stream. These are open-ended decisions; Sonnet would do a competent job but Opus will surface considerations Sonnet might miss.

### Manual prerequisites

- The application has stable persona prompts and tool definitions in known files (typically `src/prompts/` and `src/tools/`).
- You have an Anthropic API key with a separate spending cap for evals (consider it a separate cost line item).
- You’ve decided where eval results go: a Supabase table in atc-test, or an external eval platform (Braintrust, Inspect, LangSmith). The prompt below uses a Supabase table as default — change if you want external.

### Invocation

```bash
claude
```

In session:

```
/model claude-opus-4-7
```

### Prompt

```
Design and implement the AI behavior evaluation harness for AI Travel
Concierge per spec §4.1.5 and §30.6.

THIS IS A DESIGN-AND-BUILD TASK. Start with a design proposal; do not
write production code until I approve the design.

REQUIREMENTS:

1. Behavior snapshot suite. A curated set of conversation transcripts
   with expected behavior labels:
   - One eval directory per persona (marcus, maya, sofia, etc.)
   - One eval directory for hallucination-defense
   - One eval directory for tool-call correctness
   - One eval directory for safety/refusal behavior
   - Each eval is a JSON file: { input_messages: [...], expected_behavior:
     "natural-language description", evaluation_criteria: [...] }
   - Stored under evals/snapshots/

2. Evaluation runner. For each eval file:
   - Replay input_messages against the current model + prompts + tools
     configuration
   - Capture the response
   - Score the response using Claude-as-judge: a separate Anthropic call
     that evaluates whether the response satisfies expected_behavior and
     evaluation_criteria, with a structured output
     { verdict: "pass"|"fail"|"unclear", reasoning: "..." }
   - Store the result with: timestamp, git SHA, model version, eval ID,
     response, judge verdict, judge reasoning

3. Regression detection. When run on a PR or after a prompt change:
   - Compare current eval verdicts against the most recent baseline
   - "Significant regression" defined as: >5% of evals change verdict from
     pass to fail OR any safety-critical eval flips from pass to fail
   - On significant regression: fail the gate, attach the diff to the
     PR via gh CLI

4. Continuous sampling. A separate background job:
   - Reads 1% of production conversations daily (random sample)
   - Runs them through the same Claude-as-judge evaluator
   - Aggregates verdicts; alerts on a trend break (define: 3 consecutive
     days where pass rate drops more than 2 standard deviations below
     the trailing 30-day mean)
   - Stores aggregated stats in a separate "drift_stats" table; does not
     store conversation contents in this aggregate (those stay in the
     production tables under existing retention)

5. Storage schema. Three new tables in atc-test (NOT in prod) — propose
   the schemas:
   - eval_runs (one row per evaluation run, with git SHA, etc.)
   - eval_results (one row per eval per run, with verdict, reasoning,
     response)
   - drift_stats (aggregated daily counts from the 1% production sample)

DESIGN PROPOSAL FIRST. Before writing any code, write a design doc to
docs/evals/design.md covering:

a. Scoring strategy — single Claude judge call, or ensemble (e.g. 3
   judges, majority vote)? Trade-offs.
b. Judge prompt design — how to structure the judge prompt so verdicts
   are calibrated and reproducible. How to handle the "judge is the same
   model as the judged" problem (the judge being Claude Sonnet evaluating
   another Claude call — risks of self-preference).
c. Eval set hygiene — how to prevent the eval set from leaking into
   training data if Anthropic fine-tunes on our usage. Recommend marking
   eval calls with a header or routing them through a separate API
   project.
d. Regression threshold — is 5% the right number? Justify or propose
   alternative. Address the safety-critical case separately.
e. 1% sampling — random vs stratified? How to handle PII in sampled
   conversations (recall: spec §30.6 says sampled to a "separate analytics
   store").
f. Cost projection — rough estimate of $/month for the eval harness at
   current conversation volume.

After the design doc, wait for my review. Then build incrementally:
schemas first, then runner, then judge, then sampling — one file or one
concern at a time.

Do NOT write the workflow integration yet — that's a follow-up after the
harness itself is working locally.
```

### Verification

1. Read `docs/evals/design.md` carefully. The design decisions matter more than the implementation; if the judge prompt is poor or the regression threshold is wrong, the harness will produce noisy or misleading signals.
1. After the harness is built, run it against the current prompts and check that all evals pass (they should, since the baseline is the current state).
1. Deliberately introduce a known regression (e.g. tell Marcus to ask for the customer’s passport number) and confirm the harness catches it.
1. Cost estimate: validate against your Anthropic billing dashboard after the first week.

### Switch back to Sonnet at end of section

```
/model claude-sonnet-4-6
```

### Manual follow-ups

- Decide stability threshold for when the gate transitions from warning to hard-blocking on PRs. This was left undefined in the spec — log the decision in MEMORY.md.
- Set up Anthropic billing alerts on the eval spending line.
- After ~30 days of stable operation, flip the gate from warning to blocking. Track in MEMORY.md.

-----

## Section 13 — Rollback Procedures

**Model:** Sonnet 4.6
**Why Sonnet:** scripted runbooks; clear inputs and outputs.

### Manual prerequisites

- §4 complete (deploy.yml exists and has tagged previous releases).

### Invocation

```bash
claude
```

In session:

```
/model claude-sonnet-4-6
```

### Prompt

```
Create rollback runbooks for AI Travel Concierge per spec §9.

DELIVERABLES — three runbook docs and one helper script:

1. docs/runbooks/rollback-application.md:
   - Step-by-step for rolling back the production application via Vercel
   - Open Vercel Dashboard > ai-travelconcierge.com > Deployments
   - Find last known-good deployment using git tags as reference
   - Click "Promote to Production" — traffic shifts immediately
   - Verify: curl https://ai-travelconcierge.com/api/health
   - Post-rollback: open bug report, fix on new release branch (do NOT
     re-push to the failed release branch)
   - Include screenshots placeholders [SCREENSHOT: vercel-deployments]
     so I can add them later

2. docs/runbooks/cancel-before-production.md:
   - How to reject the production approval gate while the workflow is
     paused
   - GitHub Actions > pending workflow run > Review deployments > Reject
   - Pipeline stops; nothing deploys to production
   - Staging keeps the new code for continued debugging
   - Push fixes to the release branch to re-trigger the full pipeline

3. docs/runbooks/rollback-database.md:
   - Compensating migration approach (preferred): write a migration that
     reverses the problematic change, apply directly with
     supabase db push --db-url $PROD_DB_URL
   - Point-in-time restore (last resort, data corruption): Supabase
     Dashboard > atc-prod > Database > Backups
   - Strong recommendation: prefer additive migrations (add column, add
     table) because they're trivially reversible

4. scripts/check-production-version.sh:
   - Bash script that queries the production /api/health endpoint
   - Reports the git SHA / version returned and compares against the
     most recent git tag
   - Useful as a sanity check during a rollback

For each runbook, structure it as:
- "When to use this runbook" (one paragraph)
- "Prerequisites" (what access / state you need)
- "Steps" (numbered, with concrete commands or UI actions)
- "Verification" (how to confirm rollback succeeded)
- "Post-incident" (what to do after the system is stable)
```

### Verification

- Read each runbook and dry-run the steps (without actually rolling back) to confirm they’re accurate.
- Test `scripts/check-production-version.sh` against the current production endpoint.

### Manual follow-ups

- Add screenshots to the markdown files where the placeholders are.
- Link the runbooks from the team’s on-call documentation.

-----

## Section 14 — Manual Setup Checklist (Consolidated)

**Model:** N/A — this section is your checklist, not a build task.

The following are all manual steps surfaced throughout this document. Run through them once, in order, before treating the pipeline as production-ready.

### Repository setup

- [ ] `dev` is the default branch in GitHub Settings → Branches.
- [ ] Branch protection on `dev`: require PR, require CI checks, no direct commits.
- [ ] `main` is removed from Vercel’s production branch setting (Vercel Dashboard → Settings → Git).
- [ ] `PROD_DB_URL` is added as a repository-level secret with `?sslmode=require` in the connection string.
- [ ] `supabase/migrations/` directory exists and contains the full migration history.

### GitHub Environments

- [ ] `dev`, `staging`, `production` environments exist (case-sensitive).
- [ ] `production` has at least one required reviewer.
- [ ] Per-environment secrets configured per the table in §3.
- [ ] `TEST_OVERRIDE_EMAIL` and `TEST_OVERRIDE_PHONE` are set on `staging` only.

### Application code

- [ ] `src/lib/email/send.ts` wrapper exists and checks `TEST_OVERRIDE_EMAIL`.
- [ ] `src/lib/twilio/client.ts` `sendSms()` wrapper exists and checks `TEST_OVERRIDE_PHONE`.
- [ ] Audit confirms zero direct calls to `resend.emails.send()` or `client.messages.create()` outside the wrappers.
- [ ] `src/app/api/health/route.ts` returns `{ status, timestamp, version, checks: { supabase } }` with no auth required.
- [ ] Health endpoint returns 200 on `dev.ai-travelconcierge.com/api/health`.

### Pipeline files

- [ ] `.github/workflows/deploy.yml` committed to `dev`.
- [ ] `scripts/staging-fixups.sql` committed to `dev`.
- [ ] `.github/dependabot.yml` committed.
- [ ] `db/rls-snapshot.sql` committed and matches production RLS state.
- [ ] `tests/security/cross-tenant-allowlist.json` exists (even if empty).
- [ ] `tests/contracts/fixtures/` populated via `npm run contracts:record`.
- [ ] `evals/snapshots/` populated with initial eval set.

### Per-gate branch protection

- [ ] `cve-scan` is a required status check on `dev`.
- [ ] `rls-snapshot-diff` is a required status check on `dev`.
- [ ] `cross-tenant-probe` is a required status check on `dev`.
- [ ] `contract-tests` is a required status check on `dev`.
- [ ] `eval-harness` (once it goes from warning to blocking) is a required status check.

### First release dry-run

- [ ] On a feature branch, push commits and verify all PR-track gates run.
- [ ] Create `release/0.1.0` from `dev`; watch the full pipeline (CI → DB copy → staging deploy → E2E → approval gate).
- [ ] Approve the production deploy; watch tag creation and auto-merge back to `dev`.
- [ ] Verify the auto-merge PR closes cleanly and the tag exists.
- [ ] Verify Inngest functions appear in `app.inngest.com` (separate from the CI/CD scope but worth confirming).

### Ongoing operational items (track in MEMORY.md)

- [ ] AI eval harness rollout period end date — when does the gate flip from warning to hard-blocking?
- [ ] Nightly contract canary rollout period end date — when does it flip from warning to hard-blocking?
- [ ] CVE suppression review cadence — quarterly review of `cve-suppressions.md` to remove expired entries.
- [ ] Anthropic billing alert thresholds for the eval line item.
- [ ] When to retire the staging “Inngest crons disabled” override (probably never, but document).

-----

## Appendix — Where to Find What

|Need to                                       |File                                                  |
|----------------------------------------------|------------------------------------------------------|
|Modify CI/CD workflow steps                   |`.github/workflows/deploy.yml` (§4)                   |
|Change post-restore fixup behavior            |`scripts/staging-fixups.sql` (§5)                     |
|Add a new outbound channel that needs override|Add wrapper in `src/lib/<channel>/`, follow §6 pattern|
|Adjust E2E test assertion style               |`tests/e2e/` files (§7)                               |
|Add/remove a CVE suppression                  |`docs/security/cve-suppressions.md` (§8)              |
|Regenerate RLS snapshot after a migration     |`npm run rls:snapshot` (§9)                           |
|Add a route to cross-tenant probe allowlist   |`tests/security/cross-tenant-allowlist.json` (§10)    |
|Record a new contract fixture                 |`npm run contracts:record` (§11)                      |
|Add a new behavior eval                       |`evals/snapshots/<category>/<name>.json` (§12)        |
|Roll back the application                     |`docs/runbooks/rollback-application.md` (§13)         |
|Roll back the database                        |`docs/runbooks/rollback-database.md` (§13)            |