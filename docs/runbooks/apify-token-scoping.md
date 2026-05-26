# Apify API token scoping — operator runbook

## Why this matters

`APIFY_API_TOKEN` is an **account-level** secret. By default it can:

- Run ANY actor in the Apify store, charging your account.
- Read ANY of your datasets, key-value stores, request queues.
- Modify ANY of your runs, schedules, webhooks.

There is no native hard spend cap on the Apify side. A leaked token = unbounded charges until you notice and rotate.

This runbook covers the operator-side mitigation: a **scoped token** restricted to only the actors we actually use, in "restricted" injection mode so the actor itself can't escalate. The code-side mitigation (allowlist enforcement in `assertActorAllowed`) is documented in MEMORY D-090 and lives in `apps/main/src/lib/pricing/line-routing.ts`.

Both layers are required for defense-in-depth.

---

## What the scoped token looks like

A token created with these limits, granted only Run permission on these 10 actor slugs:

| Slug | Purpose |
|---|---|
| `sercul/royal-caribbean` | RCL price-watch refresh |
| `sercul/norwegian-cruise-scraper` | NCL price-watch refresh |
| `sercul/princess-cruise-scraper` | PCL price-watch refresh |
| `sercul/celebrity-cruises` | CEL price-watch refresh |
| `sercul/costa-cruises` | COS price-watch refresh |
| `sercul/carnival-cruises` | CCL price-watch refresh |
| `sercul/hal-cruises-scraper` | HAL price-watch refresh |
| `sercul/msc-cruises-scraper` | MSC price-watch refresh |
| `sercul/disney-cruises-scraper` | DSY price-watch refresh |
| `crawlerbros/cruisemapper-cruises-scraper` | Legacy itinerary (deprecated; emergency-only escape hatch gated behind `CRUISEMAPPER_ITINERARY_INGEST_ENABLED=true`) |

Injection mode: **Restricted access** — the actor receives a token with the same scope as our scoped token, preventing it from calling other actors or modifying account-level resources during the run.

A leak of this token would let the attacker run only these 10 actors. With our per-run + monthly spend caps (`APIFY_RUN_BUDGET_USD_CEILING`, `APIFY_MONTHLY_BUDGET_USD_CEILING`) the **code path** still refuses runs above those caps, but a token wielded directly against `api.apify.com` (bypassing our adapter) would burn at most ~$2/1000 results per allowed actor.

---

## How to create the scoped token

1. Sign in to console.apify.com as the account owner.
2. Settings → **API & Integrations** → **Personal API tokens**.
3. Click **Create new token**. Give it a name like `ATC-production-scoped`.
4. Toggle **"Limit token permissions"** on.
5. Under **Resource-specific permissions**, click **Add resource** → **Actor**. Add each of the 10 slugs above. For each: select permission level **Run**.
6. Do NOT grant account-level permissions (no "Run all Actors", no Storage read/write at account level, no Webhook management).
7. Under **Actor execution mode** for each actor: select **Restricted access** (this is the "inject a token with the same scope" mode). Note: the Apify docs warn that Restricted mode is not supported for Standby actors — we don't use Standby, so this is fine for us.
8. Click **Create**. Copy the token immediately — Apify shows it once.
9. Paste into Vercel: Project Settings → Environment Variables → `APIFY_API_TOKEN` → set for both Preview and Production scopes.

---

## Rotation cadence

**Quarterly minimum.** Generate a new scoped token, paste into Vercel, then revoke the old one in Apify Console after the next deploy completes (~10 minutes).

Trigger an immediate rotation if any of these happen:

- Vercel access logs show a token-bearing request you can't account for.
- An unexpected actor run shows up in your Apify Console (one whose slug isn't in our allowlist, OR one charged during an hour when our cron didn't fire).
- A team member with read access to Vercel env vars leaves the org.
- The Apify console shows any unauthorized login.

---

## If the token is suspected compromised

In order, fast:

1. **Apify Console** → Settings → API & Integrations → Personal API tokens → find the token → **Revoke**. This is instantaneous; further calls with that token fail immediately.
2. **Vercel** → Project Settings → Environment Variables → `APIFY_API_TOKEN` → **Edit** → paste a placeholder like `revoked-2026-05-26` (don't delete the key, just clear the value — keeps the schema validation passing on cold boot, even though the adapter will refuse for `no_api_token`).
3. **Audit Apify spend**: Console → Billing → Usage. Cross-reference against `apify_spend_ledger` rows in our DB. Any spend in Apify NOT in our ledger = attacker activity.
4. Create a fresh scoped token (steps 1–9 above), paste into Vercel, redeploy.
5. File a postmortem entry in `MEMORY.md` with timeline + estimated cost impact.

`APIFY_ADAPTER_ENABLED=false` is a faster blunt-instrument kill switch if you can't immediately rotate — it halts our own dispatch, but doesn't help if the token is being used elsewhere.

---

## Spend monitoring (no native alert)

Apify does not expose a budget-alert webhook. Our equivalents:

- **`apify_spend_ledger` table**: every dispatch (success, fail, allowlist violation, skipped) writes a row with `spend_usd`, `actor_id`, `status`. Operator dashboard queries this.
- **`checkMonthlyBudget`**: month-to-date sum against `APIFY_MONTHLY_BUDGET_USD_CEILING` (default $500). When the cap is hit, `refreshTrackedSailings` refuses + fires a `sendOperatorAlert(severity: "high", signal: "apify_monthly_budget_exhausted")`.
- **Per-run cap**: `APIFY_RUN_BUDGET_USD_CEILING` (default $50). Estimated pre-flight spend over the cap → run refused, ledger row tagged `estimated_skipped`.
- **Out-of-band recommended**: in the Apify Console set up an email notification for "Daily usage > $X" (Settings → Notifications → Usage). This catches anomalies that bypass our adapter entirely.

---

## Adding a new actor

When a new line gets a confirmed slug, OR a new use case adds an actor:

1. Add the slug to `APIFY_ACTOR_ALLOWLIST` in `apps/main/src/lib/pricing/line-routing.ts`. Update the count assertion in `line-routing.test.ts`.
2. Edit the scoped token in Apify Console: add the new actor as a Run-permission resource with Restricted-access injection.
3. Deploy. Run the actor once via the adapter; verify a ledger row lands.

Order doesn't matter — the run won't succeed until both layers permit it.

---

## What this doesn't protect against

- A bug in our adapter that leaks the token in a log or error trace. We avoid this by URL-encoding the token into the query string only, never logging it. CodeQL log-injection checks are in CI.
- A compromised developer laptop where `.vercel/.env.production.local` has been pulled. Mitigation: don't `vercel env pull` for production env on a personal machine; pull only `preview`.
- An attacker who's already escalated to write access on this repo. They could add a new entry to `APIFY_ACTOR_ALLOWLIST`, expand the scoped token's allowed actors, and re-deploy. Mitigation: branch protection on `dev` + manual release approval gate (already in place).
