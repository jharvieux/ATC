# Build Prompts — Spec Addendum §33 (External Data Sources & Media Assets)

## How this addendum builds on Prompts 01–32

Prompts 01–32 deliver the platform per Spec v6.2 Parts 1–9. This addendum lands on top of that completed work to add:

- **External pricing data** via Apify actors for per-cruise-line scrapers, behind a `PricingDataSource` adapter that mirrors the §13 `HostAgencyClient` pattern.
- **CruiseMapper reference data** ingested into the RAG service at `global` scope — ships, ports, deck plans — via two paths: Apify for itineraries, DIY HTTP fetch for static content.
- **Media assets** (deck plan images, ship photos, port maps) as a first-class retrievable surface, with consumer-side display in chat responses.
- **Price-watch subscriptions** that let subscribers configure threshold-based notifications when pricing drops for sailings they're tracking.

All nine prompts assume Prompts 01–32 are committed, the existing migration/lint/test gates remain active, and the `tenantClient` / `withPlatformAdminAudit` / Inngest scaffolding from the original spec is in place. Each prompt names the addendum sections it depends on.

-----

## Prerequisites added by the addendum

These extend the Part 1 + Part 3 prerequisites lists. None of this is code work; line it up before Build Prompt 33.

### 1. New cloud services / accounts

| Service | What you need | Used in prompts |
|---|---|---|
| **Apify account** | Single platform Apify account on the **Starter plan** ($29/mo + $29 prepaid). Generate an API token. Scale plan ($199) is the upgrade path when tracked-booking volume justifies — not needed at launch. | 33, 34, 35 |
| **Supabase Storage bucket** | A public bucket named `rag-media-public` in the RAG service's Supabase project. Created in Build Prompt 33. | 33, 37 |

### 2. Decisions to make before Build Prompt 33

- **Per-line actor IDs to confirm:** The Royal Caribbean, Norwegian, Princess, Celebrity, and Costa actors (all by `sercul`) are verified at the time of writing. Carnival, Holland America, MSC, and Disney are mentioned in Apify's catalog but the exact actor slugs were not pinned. Confirm slugs by browsing the Apify store before Prompt 34.
- **Budget caps:** Confirm starting values for `APIFY_RUN_BUDGET_USD_CEILING` (default 50) and `APIFY_MONTHLY_BUDGET_USD_CEILING` (default 500). These are operator preferences.
- **Operations contact email** for the `CRUISEMAPPER_DIY_USER_AGENT` header. Should be a monitored mailbox so that if CruiseMapper has a problem with our scraping, they can reach us before they block us.
- **Counsel sign-off** on the ToS posture for both cruise-line scraping (via Apify) and CruiseMapper DIY scraping. This is a launch-gate item, not a build-time blocker — Prompts 33–41 can be built before counsel signs off, but production traffic should not flow until counsel has reviewed.

### 3. Open items the spec leaves to implementation

- **Lines without any Apify actor** (Virgin, Viking, Oceania, Regent, Silversea, Seabourn): the adapter returns `null` for these. The UX surface for "no price-watch available on this line" is a UI-design decision deferred to Prompt 40.
- **Display markup syntax:** `[[display_asset:<id>]]` is the working form. If the AI agents do not emit this markup reliably during Prompt 39 dev testing, the fallback is a tool-call shape. Decided at build time in Prompt 39.
- **Sample-OCR uplift criteria:** What does "good enough" mean for Haiku vision output on the 200-image sample? Decided when the eval is set up in Prompt 41.

-----

## How to use the build prompts below

Same pattern as Prompts 08–14. Each prompt is self-contained for Claude Code. The header block names the model; the footer switches back to Sonnet (or stays if already Sonnet). Run in order — there are real dependencies between them. **Two of the nine prompts use Opus** (Prompt 36, the first DIY scraper because polite-scraping discipline is the hard-to-fix-later concern; and Prompt 39, because it adds a layer to §21.10's hallucination defense). **One uses Haiku** (Prompt 41, a one-off OCR evaluation script).

-----

# BUILD PROMPT 33 — Schema + storage: pricing_cache, price_watches, rag_media_assets, related_asset_ids, media bucket

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.6 (rag_media_assets, related_asset_ids), §33.8.1 (price_watches), §33.2 / §33.3 (pricing_cache as the substrate for PricingDataSource), §33.6.3 (storage bucket). References existing §6.4 (knowledge_chunks table) for the column add.

**Prerequisite check:** Prompts 01–32 are committed. The main app and RAG service Supabase projects exist with their respective migrations runnable. The Supabase CLI is configured for both projects.

**Goal:** Land all schema migrations and the storage bucket configuration for the addendum work. Pure migration/configuration prompt — no behavior, no business logic. Subsequent prompts assume these tables and the bucket exist.

**Tasks:**

1. **Main app migration: `pricing_cache` table.** New migration in `apps/main/supabase/migrations/`:
   - Table `public.pricing_cache` with columns: `id UUID PK DEFAULT gen_random_uuid()`, `cruise_line TEXT NOT NULL`, `ship TEXT NOT NULL`, `sail_date DATE NOT NULL`, `departure_port TEXT NOT NULL`, `duration_nights INT NOT NULL`, `cabin_class TEXT NOT NULL CHECK (cabin_class IN ('interior','oceanview','balcony','mini_suite','suite'))`, `price_amount NUMERIC(10,2) NOT NULL`, `price_currency TEXT NOT NULL`, `fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `source TEXT NOT NULL`, `actor_run_id TEXT NULL`, `raw_payload JSONB NULL`.
   - UNIQUE constraint on `(cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class)` — this is the upsert key for the adapter.
   - Indexes: `idx_pricing_cache_lookup (cruise_line, ship, sail_date, cabin_class)`, `idx_pricing_cache_fetched_at (fetched_at)` for staleness queries.
   - This table is **platform-scoped, not tenant-scoped.** Pricing is reference data shared across all tenants. No tenant_id column. RLS: disabled (service-role only access; comment in migration explaining the exception).

2. **Main app migration: `price_watches` table.** New migration, exactly the schema in addendum §33.8.1. Pay attention to:
   - The `threshold_present` CHECK constraint that enforces dollar/percent presence depending on `threshold_kind`.
   - Both indexes (`idx_watches_tenant_status` and `idx_watches_sailing`).
   - The FK on `subscriber_user_id` REFERENCES `users(id) ON DELETE CASCADE`.
   - The FK on `booking_id` REFERENCES `bookings(id) ON DELETE CASCADE` and is NULLABLE (a watch may exist for a sailing without a booking yet, e.g., subscriber pre-watches a sailing they intend to book).
   - RLS enabled: tenant-scoped table, so policies follow the standard tenant_id pattern from Prompt 02.

3. **RAG service migration: `rag_media_assets` table.** New migration in `apps/rag/supabase/migrations/`. Schema exactly as addendum §33.6.1:
   - Five columns of metadata (kind, entity_type, entity_id, scope, tenant_id) plus the storage pointer (storage_path, public_url), file metadata (content_type, width_px, height_px, file_bytes, file_hash), and timing/provenance (fetched_at, source).
   - The `tenant_id_when_tenant_scope` CHECK constraint enforces that tenant_id is non-null iff scope='tenant'.
   - All three indexes from the spec (`idx_assets_entity`, `idx_assets_kind`, `idx_assets_tenant`).
   - No RLS — RAG service is service-role-only per Prompt 06 decision. Add SQL comment explaining; document in `apps/rag/db/rls-exceptions.txt`.

4. **RAG service migration: `knowledge_chunks.related_asset_ids` column.** New migration adding `related_asset_ids UUID[] NOT NULL DEFAULT '{}'::UUID[]` to `rag.knowledge_chunks`. Add a comment on the column noting that asset IDs MUST reference rows in `rag_media_assets` of compatible scope (a global chunk should not reference a tenant-scope asset, and vice versa). The compatibility check is enforced in application code, not by FK — UUID arrays don't support FK constraints cleanly.

5. **Main app migration: `apify_spend_ledger` table.** New migration. Used by Prompt 34's monthly-budget-cap enforcement:
   - Table `public.apify_spend_ledger` with columns: `id UUID PK DEFAULT gen_random_uuid()`, `occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `actor_id TEXT NOT NULL`, `actor_run_id TEXT NULL`, `amount_usd NUMERIC(10,4) NOT NULL`, `context TEXT NOT NULL` (e.g., 'general_refresh', 'tracked_refresh', 'itinerary_refresh'), `cruise_line TEXT NULL` (when the spend is attributable to a specific line).
   - Index: `idx_apify_spend_ledger_month (occurred_at)` to support the monthly-sum query the adapter runs before every actor invocation.
   - Platform-scoped, no tenant_id. RLS disabled (service-role only access; comment in migration explaining the exception).

6. **Supabase Storage bucket configuration.** In the RAG service's Supabase project, create the `rag-media-public` bucket via Supabase CLI or migration script:
   - Bucket policy: public read, authenticated write (service role only in practice).
   - MIME types allowed: `image/png`, `image/jpeg`, `image/webp`.
   - File size limit: 5 MB per file.
   - Document the bucket creation in a new file `apps/rag/db/storage-buckets.md` listing bucket name, purpose, access policy, and the migration commit it was created in.

7. **Type generation.** Re-run the Supabase type generation for both main app and RAG service so the new tables and columns appear in the TypeScript types. Verify nothing else regenerated unexpectedly.

8. **Migration tests.** Add minimal smoke tests in each project's existing migration test suite:
   - `pricing_cache` upsert on the unique key works (insert, then upsert with same key → updates, not duplicates).
   - `price_watches` CHECK constraints reject invalid threshold combinations.
   - `rag_media_assets` CHECK constraint rejects scope='tenant' with null tenant_id and scope='global' with non-null tenant_id.
   - `knowledge_chunks.related_asset_ids` accepts an empty array and accepts an array of UUIDs.
   - `apify_spend_ledger` inserts and sums correctly across a date range (basic smoke).

**Definition of done:**

- All five migrations applied cleanly in fresh local Supabase reset for both projects.
- `pricing_cache`, `price_watches`, `apify_spend_ledger`, `rag_media_assets` visible in their respective projects.
- `knowledge_chunks.related_asset_ids` column present.
- Supabase Storage bucket `rag-media-public` exists with the correct policy.
- Migration smoke tests pass.
- TypeScript types regenerated and committed.
- `pnpm typecheck` and `pnpm test` green in both apps.

**After completion:** MEMORY.md entry covering (a) any deviation from the spec'd schema, (b) the bucket creation method actually used (CLI vs migration script — both acceptable, just record which), and (c) confirmation that `rls-exceptions.txt` was updated for the new RAG table.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 34 — PricingDataSource interface, ApifyPricingAdapter (per-line scrapers), cache, kill switches, mock

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.2 (interface), §33.3 (adapter, routing table, cost/kill-switch behavior), §33.9.3 (budget caps), §33.9.4 (kill switches), §33.10 (env vars). References existing §13 for the adapter-pattern precedent.

**Prerequisite check:** Prompt 33 committed (pricing_cache table exists). Apify account is provisioned and the API token is in env vars per the addendum prerequisites. The per-line actor slugs have been confirmed in the Apify store and are documented in MEMORY.md.

**Goal:** Implement the `PricingDataSource` interface, the Apify-backed implementation that routes per-line, the cache write path, the per-run and monthly budget cap enforcement, the kill switch, and a `MockPricingDataSource` for tests.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts` with the four new vars from addendum §33.10: `APIFY_API_TOKEN` (required, secret), `APIFY_ADAPTER_ENABLED` (default true), `APIFY_RUN_BUDGET_USD_CEILING` (default 50), `APIFY_MONTHLY_BUDGET_USD_CEILING` (default 500). Plus the two freshness vars: `PRICE_FRESHNESS_FRESH_HOURS` (default 72) and `PRICE_FRESHNESS_EXPIRED_HOURS` (default 168). All validated at boot via the existing `verifyEnvAtBoot()` mechanism from Prompt 01.

2. **Interface definition.** Create `apps/main/src/lib/pricing/types.ts`:
   - Exports `PricingDataSource` interface exactly as addendum §33.2.
   - Exports the key types: `SailingKey`, `CachedPriceQuote`, `CabinClass`, `CruiseLineCode`, `RegionCode`, `RefreshResult`.
   - `RefreshResult` includes counts (sailings refreshed, sailings failed), the actor_run_id when applicable, the dollar amount spent on the run, and a `partial: boolean` flag set when a budget cap halted the run early.

3. **MockPricingDataSource.** Create `apps/main/src/lib/pricing/mock-pricing-data-source.ts`:
   - In-memory implementation. `refreshGeneralPricing` and `refreshTrackedSailings` write to an internal Map; `getCachedPrice` reads.
   - Supports seeding via a constructor option for deterministic test fixtures.
   - Used by every test that needs a `PricingDataSource` without burning Apify credits.

4. **ApifyPricingAdapter — core.** Create `apps/main/src/lib/pricing/apify-pricing-adapter.ts`:
   - Constructor accepts the Apify token and the budget config.
   - First action of every public method: check `APIFY_ADAPTER_ENABLED` and the monthly budget. If disabled or over budget, refresh methods return immediately with `partial: true` and a reason. `getCachedPrice` is unaffected — reads continue from the cache.
   - Uses the Apify HTTP API directly (not the SDK) — keep the dependency surface small. POST to `https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items?token={token}` with the actor's input JSON.
   - Times out actor runs after 5 minutes; on timeout, the run is marked failed and partial results (if any) are still written to cache.

5. **Per-line routing.** Create `apps/main/src/lib/pricing/line-routing.ts`:
   - A map from `CruiseLineCode` to `{ actorId, inputBuilder, outputMapper }`.
   - `actorId` is the Apify slug (e.g., `sercul/royal-caribbean`).
   - `inputBuilder` takes a refresh request and produces the actor's specific input JSON.
   - `outputMapper` takes one item from the actor's output dataset and produces a normalized `CachedPriceQuote` (or null if the item is unmappable — log and skip).
   - Initial coverage: Royal Caribbean, Norwegian, Princess, Celebrity, Costa (the five verified `sercul` actors). Add Carnival, Holland America, MSC, Disney behind feature flags so they can be enabled as their actor IDs are confirmed.
   - For unmapped lines, the routing returns null; adapter returns null from `getCachedPrice` for these and skips them in refresh operations with a log entry.

6. **Cache writes.** Create `apps/main/src/lib/pricing/pricing-cache.ts`:
   - `upsertPriceQuote(quote: CachedPriceQuote): Promise<void>` — upserts on the unique key from Prompt 33.
   - `readPriceQuote(key: SailingKey): Promise<CachedPriceQuote | null>` — returns null if not in cache.
   - `readPriceQuote` also computes the `freshnessFlag` at read time from `fetched_at` and the env-var thresholds.

7. **Batching for tracked sailings.** In `refreshTrackedSailings`:
   - Group the input `SailingKey[]` by `(line, departure_port, sail_date_window)` where the window is a 30-day bucket.
   - For each group, dispatch one actor run with filters that cover the bucket.
   - After the run, match returned items to the input keys; update only the matching ones.
   - This is the single most important cost-control mechanism in the adapter. Add a unit test that proves a request for 30 sailings from RCL Caribbean in the same month dispatches one actor run, not 30.

8. **Budget cap enforcement.**
   - **Per-run:** Before dispatching an actor run, estimate cost from the actor's pricing (per-result fee × expected results, plus a CU buffer). If estimate > `APIFY_RUN_BUDGET_USD_CEILING`, halt with a partial-result flag and a log entry.
   - **Monthly:** Track spend in the `apify_spend_ledger` table created in Prompt 33. Insert one row per actor invocation with the actual spend after the run completes. Before any new run, sum the current calendar month's ledger and compare to `APIFY_MONTHLY_BUDGET_USD_CEILING`. If at or over, no new runs.
   - Spend amount is computed from the actor's billing data returned in the Apify API response (per-result fees + compute) when available; otherwise from the cost estimate used in the per-run check, flagged in the ledger row's `context` field as `estimated`.

9. **Integration test against a real actor run on Free tier.** A single integration test, gated by an env-var flag (off in CI by default), that actually dispatches a small Royal Caribbean run and verifies the output is parsable into `CachedPriceQuote`. This is the smoke test that proves the adapter works end-to-end. Document how to enable it in the test file's header comment.

**Definition of done:**

- `PricingDataSource` interface defined and exported.
- `MockPricingDataSource` implements the interface and is used in at least three unit tests.
- `ApifyPricingAdapter` implements the interface, routes per-line, writes to cache, enforces both budget caps and the kill switch.
- Batching test proves the cost-control claim.
- `apify_spend_ledger` table exists and the adapter writes to it.
- All five verified per-line actors have working `inputBuilder` + `outputMapper` mappings.
- `pnpm test` green.

**After completion:** MEMORY.md entry noting (a) which per-line actors were enabled at launch vs. left feature-flagged, (b) the actual per-run cost observed in the smoke test (so we calibrate the default budget cap with real data), and (c) any divergences from the addendum's specified interface shape.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 35 — CruiseMapper itinerary ingest via Apify (monthly Inngest job)

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.4 (CruiseMapper itinerary ingest path), §33.3 (rides the same adapter / budget infra from Prompt 34). References §22.4 (normalization pipeline for chunk creation) and §6.3 (authority tier for `low`).

**Prerequisite check:** Prompts 33–34 committed. The `crawlerbros/cruisemapper-cruises-scraper` actor ID confirmed in Apify store (no proxy required per actor docs, but verify before build).

**Goal:** Add a monthly Inngest scheduled function that runs the CruiseMapper itinerary actor, writes itineraries to `pricing_cache` (where they cross-cut with the pricing flow), and ingests them as `global`-scope `low`-authority chunks into the RAG service.

**Tasks:**

1. **Actor wrapper.** Extend `apps/main/src/lib/pricing/apify-pricing-adapter.ts` (or create a sibling module under `apps/main/src/lib/external/cruisemapper/`) with a `runCruiseMapperItineraryActor()` method that:
   - Dispatches the `crawlerbros/cruisemapper-cruises-scraper` actor with the broadest viable input (all destinations, the next 24 months of departures).
   - Pages through results if the actor returns paginated output.
   - Returns the raw items along with the spend ledger entry.

2. **Itinerary normalization.** Create `apps/main/src/lib/external/cruisemapper/itinerary-mapper.ts`:
   - Maps each itinerary item to two outputs:
     - A `CachedPriceQuote`-shaped record (where the actor included a starting price) for `pricing_cache`.
     - A text document for RAG ingest: structured text like "Royal Caribbean's Symphony of the Seas departs Miami on 2026-08-15 for a 7-night Eastern Caribbean cruise visiting Cozumel, Roatán, Costa Maya. Starting price $649." Keep the prose dense and factual — this becomes a chunk via the §22.4 pipeline.

3. **RAG ingest hook.** The text documents are pushed to the RAG service via the existing `/api/ingest` endpoint with:
   - `scope: 'global'`
   - `authority: 0.45` (mid-`low` tier per §6.3)
   - `category: 'itinerary'` (extend the category enum in the RAG service if needed — check existing values and propose an addition in MEMORY.md if so)
   - `source: 'cruisemapper.com'`
   - The `fetched_at` flows through to chunk metadata for §21.7 freshness handling.

4. **Inngest scheduled function.** Create `apps/main/src/inngest/functions/refresh-cruisemapper-itineraries.ts`:
   - Cron: 1st of every month at 03:00 UTC (low-traffic window).
   - Calls the actor wrapper, applies the mapper, writes to `pricing_cache`, ingests into RAG.
   - Respects the budget caps from Prompt 34.
   - Logs counts (items received, items mapped to cache, items ingested to RAG, items skipped with reasons).
   - Emits a completion event with structured metadata for observability.

5. **De-duplication on RAG ingest.** Itineraries the actor returns this month likely overlap with last month's. The ingest pipeline must:
   - Use a deterministic chunk-source identifier per itinerary (e.g., `cruisemapper:itinerary:{line}:{ship}:{sail_date}:{duration}`).
   - On re-ingest of the same identifier, REPLACE the existing chunk rather than creating a duplicate. The §8 ingest contract likely already supports this via an upsert key; verify and use it.

6. **Tests.**
   - Unit tests for the itinerary mapper with representative actor output fixtures.
   - Integration test (gated, like Prompt 34's) that runs a small actor invocation and verifies a chunk lands in the RAG service.
   - Idempotency test: ingest the same itinerary twice; verify exactly one chunk exists for it.

**Definition of done:**

- Monthly Inngest function exists and is registered.
- A manual trigger of the function in dev runs end-to-end: actor → mapper → cache writes + RAG ingest.
- Idempotency confirmed.
- Categories enum updated in RAG service (or existing category reused) and documented.
- `pnpm test` green.

**After completion:** MEMORY.md entry noting (a) which RAG category was used (existing vs. new), (b) the actor's actual output volume in one run, and (c) the typical text length per itinerary chunk so we know if we're producing ~500-token chunks per §B.5.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 36 — CruiseMapper DIY static ingest: ships + ports (text-only, no images yet)

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This is the first DIY scraper on the platform. The polite-scraping discipline — robots.txt enforcement, rate limit, identifying User-Agent, hash-based change detection, backoff on errors — is the entire reason DIY is safe to do. Getting any of these wrong means either getting blocked by CruiseMapper (loss of data source) or causing them load they didn't sign up for (a real ethical and legal issue). The scraping machinery this prompt builds is reused by Prompt 37 for deck plans, so a defect here costs twice. Worth Opus.

**Spec references:** Addendum §33.5 (DIY ingest pipeline, polite scraping discipline), §33.9.2 (robots.txt), §33.9.4 (kill switch). References §22.4 (normalization pipeline), §6.3 (authority tier).

**Prerequisite check:** Prompts 33–35 committed. Confirm CruiseMapper's `robots.txt` allows access to `/ships/*` and `/ports/*` paths. (If it doesn't, halt and escalate to operator before proceeding.) Confirm `CRUISEMAPPER_DIY_USER_AGENT` env var is set to a value identifying the platform with a real contact email.

**Goal:** Build the DIY scraping machinery — fetcher, parser, rate limiter, robots.txt checker, change detection, backoff, kill switch — and use it to ingest CruiseMapper ship registry and port detail pages into RAG. **No image work in this prompt** — that lands in Prompt 37, using the same machinery. Text-only chunks at `global` scope, `low` authority.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts` with `CRUISEMAPPER_DIY_USER_AGENT` (required), `CRUISEMAPPER_DIY_INGEST_ENABLED` (default true), `CRUISEMAPPER_DIY_RATE_LIMIT_RPS` (default 1.0). Validated at boot.

2. **HTTP fetcher with discipline.** Create `apps/main/src/lib/external/cruisemapper/diy-fetcher.ts`:
   - Single exported function `fetchCruiseMapperPage(url: string, options: { previousHash?: string }): Promise<FetchResult>`.
   - Sends GET with the `CRUISEMAPPER_DIY_USER_AGENT` header. No cookies, no proxy, no JavaScript execution.
   - Internal rate limiter (token bucket) enforces `CRUISEMAPPER_DIY_RATE_LIMIT_RPS` across ALL concurrent callers in the process. Use a process-wide singleton.
   - Computes SHA-256 of the response body. If `previousHash` matches, returns `{ status: 'unchanged', hash }` without re-parsing.
   - On 4xx (except 429), returns `{ status: 'client_error', code, url }` and does NOT retry.
   - On 5xx or 429, exponential backoff with jitter: 1s, 2s, 4s. After 3 retries, returns `{ status: 'server_error', code, url }`.
   - On network error, same backoff policy as 5xx.
   - Each fetch logs: URL, status, latency, hash (or "unchanged"). Logs go to the standard platform logger.

3. **robots.txt enforcement.** Create `apps/main/src/lib/external/cruisemapper/robots-check.ts`:
   - Function `checkRobotsAllowed(url: string): Promise<boolean>` that fetches `https://www.cruisemapper.com/robots.txt` (cached for 24 hours), parses it, and returns whether the platform's User-Agent is allowed to access the given URL.
   - Use a small robots.txt parser library (e.g., `robots-parser` on npm) rather than writing one — well-tested, low surface area.
   - Every call to `fetchCruiseMapperPage` first calls `checkRobotsAllowed`. If disallowed, the fetch returns `{ status: 'robots_disallowed', url }` without sending a request, and emits an admin alert (high priority — this is a config drift signal).

4. **Kill switch.** All scraping operations check `CRUISEMAPPER_DIY_INGEST_ENABLED` before starting. When false, the Inngest job no-ops with a log entry. Existing chunks in RAG are untouched.

5. **Ship registry parser.** Create `apps/main/src/lib/external/cruisemapper/parsers/ship-parser.ts`:
   - Function `parseShipPage(html: string, sourceUrl: string): ParsedShip | null`.
   - Uses `cheerio` (already in stack) to extract: ship name, cruise line, year built, builder, ship class, flag state, length, beam, draft, gross tonnage, passenger capacity, crew count, deck count, cabin count.
   - Produces a single text document suitable for RAG ingest: dense prose describing the ship's specs, ready for §22.4 chunking.
   - Returns `null` if the page structure has changed in a way the parser doesn't recognize. Alerts admin.

6. **Port detail parser.** Create `apps/main/src/lib/external/cruisemapper/parsers/port-parser.ts`:
   - Function `parsePortPage(html: string, sourceUrl: string): ParsedPort | null`.
   - Extracts port name, country, region, terminal info (where present), transit notes, nearby attractions.
   - Same prose-output pattern as the ship parser.

7. **URL discovery.** Create `apps/main/src/lib/external/cruisemapper/discovery.ts`:
   - Function `discoverShipUrls(): Promise<string[]>` — scrapes the CruiseMapper ship index page(s) to enumerate ~1,500 ship detail URLs.
   - Function `discoverPortUrls(): Promise<string[]>` — same for ports.
   - Discovery itself is subject to the rate limiter and robots.txt check.
   - Discovered URLs are cached in a new table `cruisemapper_url_inventory (url TEXT PK, kind TEXT, last_seen_at TIMESTAMPTZ, content_hash TEXT NULL)` so subsequent runs can do change detection. Add a migration for this.

8. **Inngest scheduled function: quarterly ship + port refresh.** Create `apps/main/src/inngest/functions/refresh-cruisemapper-static.ts`:
   - Cron: 1st of January, April, July, October at 02:00 UTC.
   - Discovers ship + port URLs.
   - For each URL: fetch (with change detection), parse, ingest into RAG.
   - On parse failure: skip the URL, log, increment a failure counter. If failure rate > 5%, halt the run and alert admin (parser likely broken).
   - Idempotent: re-ingestion uses a deterministic source identifier (`cruisemapper:ship:{ship-id}` or `cruisemapper:port:{port-id}`) so chunks update in place.

9. **RAG ingest call.** Posts to the RAG service's `/api/ingest` with `scope: 'global'`, `authority: 0.45`, `category` matching the content type (`ship_intel` or `port_intel` — extend category enum if needed), `source: 'cruisemapper.com/...'`.

10. **Tests.**
    - Unit tests for both parsers with representative HTML fixtures (download a few real CruiseMapper pages, anonymize if needed, commit as fixtures).
    - Unit test for the rate limiter under concurrent load.
    - Unit test for the robots.txt check with a fake robots.txt that disallows our user agent.
    - Integration test (gated) that runs against the real site for 5 ships and 5 ports, asserts chunks appear in RAG, then deletes them.

**Definition of done:**

- `pnpm typecheck` and `pnpm test` green.
- The rate limiter genuinely enforces ≤1 req/sec under concurrent load (test proves it).
- robots.txt is checked before every fetch and the disallowed path is honored.
- The kill switch takes effect immediately.
- A dev run ingests at least 10 ships and 10 ports successfully.
- Re-running the dev ingest produces zero net changes (idempotency).

**After completion:** MEMORY.md entry covering (a) the actual CruiseMapper robots.txt content at the build date, (b) any parser fragility observed (e.g., "the cabin_count selector matches on three different DOM patterns we had to fall through"), (c) the total number of discovered URLs by kind, and (d) the actual quarterly cost (compute, bandwidth) of running the job.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 37 — CruiseMapper DIY deck plan ingest with image storage (text descriptions + image assets)

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.5 (DIY pipeline for deck plans), §33.6 (rag_media_assets schema, storage bucket, related_asset_ids). Reuses the machinery from Prompt 36.

**Prerequisite check:** Prompt 36 committed (DIY fetcher, robots.txt check, rate limiter, parser pattern all working for ships and ports). Storage bucket `rag-media-public` exists from Prompt 33.

**Goal:** Extend the DIY ingest to handle deck plan pages — extract the structured text description (cabin number ranges, cabin categories, deck-level notes), download the deck plan images, store images in Supabase Storage as `rag_media_assets`, and link the text chunks to their images via `related_asset_ids`.

**Tasks:**

1. **Deck plan parser.** Create `apps/main/src/lib/external/cruisemapper/parsers/deck-parser.ts`:
   - Function `parseDeckPlanPage(html: string, sourceUrl: string): ParsedDeckPlan | null`.
   - Extracts: ship name + slug, deck number, deck label, cabin number ranges, cabin categories with codes (e.g., "Inside 1T 3V 6V"), deck-level notes (e.g., "in-hull balconies"), list of public venues on the deck.
   - Extracts the deck plan image URL(s) from the page. Some pages have one image, some have multiple views.
   - Returns the structured data plus the image URLs as a separate array.

2. **Image download + storage.** Create `apps/main/src/lib/external/cruisemapper/image-uploader.ts`:
   - Function `uploadDeckPlanImage(imageUrl: string, metadata: {...}): Promise<AssetRecord>`.
   - Downloads the image via the DIY fetcher (subject to the same rate limit and robots.txt check).
   - Computes SHA-256 of the bytes. If a `rag_media_assets` row with this `file_hash` already exists, return the existing asset_id without re-uploading.
   - Otherwise: upload to `rag-media-public/deck-plans/{ship-slug}/deck{NN}-{hash-prefix}.{ext}`. Use the file extension matching the response Content-Type.
   - Insert a `rag_media_assets` row with kind='deck_plan', entity_type='deck', entity_id=`{ship-slug}-deck-{NN}`, scope='global', the storage path, the public URL, content type, dimensions (parsed from response or computed), file_bytes, file_hash, fetched_at=NOW(), source='cruisemapper.com'.
   - Return the new asset_id.

3. **Chunk + asset linking.** When ingesting deck plan text:
   - Create the text document for §22.4 normalization as before.
   - Pass the array of asset_ids in the ingest payload via a new optional field `related_asset_ids: UUID[]`.
   - Extend the RAG service `/api/ingest` endpoint to accept and store this field on the created chunk. This is a small but real API change.

4. **RAG service `/api/ingest` extension.** Modify the RAG service's existing ingest handler:
   - Accept `related_asset_ids?: string[]` in the request body (Zod-validated, optional, default empty array).
   - When creating the chunk row, set `knowledge_chunks.related_asset_ids` to the provided value.
   - Validation: if any provided asset_id does not exist in `rag_media_assets`, OR if the asset's scope is incompatible with the chunk's scope (a 'global' chunk cannot reference a 'tenant' asset and vice versa), return 400 with a clear error.

5. **Deck URL discovery.** Extend `discovery.ts` from Prompt 36 with `discoverDeckPlanUrls(): Promise<string[]>`. For each ship in `cruisemapper_url_inventory`, discover its deck plan URLs (the ship page lists them). Cache in `cruisemapper_url_inventory` with kind='deck_plan'.

6. **Inngest function extension.** Extend `refresh-cruisemapper-static.ts` from Prompt 36 to also process deck plan URLs in the same quarterly run. Order: ships first (so deck plans can reference them), then ports, then deck plans. Deck plans depend on ship discovery having run.

7. **Image format handling.** Store images as-is (the addendum confirms "originals" over WebP normalization). The bucket's MIME types from Prompt 33 allow PNG, JPEG, WebP — accept any of these from CruiseMapper. Reject and log anything else.

8. **Tests.**
   - Unit tests for the deck parser with HTML fixtures.
   - Unit test for image-uploader with a mock storage client: verifies hash dedup works (uploading same image twice produces one asset row).
   - Integration test (gated): scrape 3 deck plans for one ship, verify chunks land in RAG with non-empty `related_asset_ids`, verify images are accessible via the public URLs.
   - Validation test for the RAG ingest extension: rejects mismatched-scope asset references, accepts matched-scope ones.

**Definition of done:**

- A dev run ingests at least 3 ships' full deck plan sets (~30-50 chunks + same number of asset rows).
- Each chunk has non-empty `related_asset_ids`.
- Each referenced asset is publicly accessible via its `public_url`.
- Re-running produces zero net changes (idempotency by file_hash for images, by source identifier for chunks).
- `pnpm typecheck` and `pnpm test` green.

**After completion:** MEMORY.md entry covering (a) average images per ship (so we can recalibrate the ~18,000 estimate), (b) average image size, (c) total storage used after the dev backfill, (d) any parser failure modes encountered.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 38 — RAG retrieve API extension: return asset metadata alongside chunks

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.6.4 (retrieve API extension). References §8.4 (existing /api/retrieve) — extension, not replacement.

**Prerequisite check:** Prompts 33, 36, 37 committed. Chunks with non-empty `related_asset_ids` exist in the dev RAG service.

**Goal:** Extend the existing `/api/retrieve` endpoint so its response includes asset metadata for any assets referenced by returned chunks. The chunk shape gains `related_asset_ids` in the response (already present in the table from Prompt 33). A new top-level `assets` array carries the metadata.

**Tasks:**

1. **Response schema extension.** Modify the RAG service's `/api/retrieve` handler:
   - Each chunk object in the response gains `related_asset_ids: string[]` (passes through what's in the row).
   - The response gains a top-level `assets: AssetMetadata[]` array.
   - `AssetMetadata` shape: `{ asset_id, kind, entity_type, entity_id, public_url, caption, width_px, height_px, content_type }`. Includes only fields safe to expose to consumers (no internal paths, no file hashes).

2. **Asset lookup.** After computing the final retrieved chunks (post-filtering, post-deduplication per §21.3), collect the union of all `related_asset_ids` across them. Single batched query to `rag_media_assets`. Map results to the response.

3. **Deduplication of assets.** If three chunks all reference the same asset_id, the `assets` array contains it once, not three times. Chunks still list the ID in their `related_asset_ids`.

4. **Scope enforcement.** Assets are filtered by the same scope rules as chunks:
   - The retrieve JWT establishes the caller's tenant context.
   - Global chunks may reference global assets only (already enforced on ingest, but re-validate at retrieve time as defense in depth).
   - If a chunk references an asset that no longer exists (deleted between ingest and retrieve), the chunk is still returned but the asset_id is silently dropped from the response. Log to telemetry.

5. **No change to chunk filtering logic.** The §21.3 confidence floor, dedup, and top-N selection happen first; asset hydration happens after. Asset presence does NOT affect chunk ranking.

6. **Update OpenAPI / TypeScript types** for the RAG service to reflect the new response shape.

7. **Tests.**
   - Unit test: retrieve with chunks that have no assets → response has empty `assets` array, chunks have empty `related_asset_ids`. No regression.
   - Unit test: retrieve with chunks that have one asset each → `assets` array contains one entry per unique asset.
   - Unit test: retrieve where two chunks share an asset → `assets` array has one entry, both chunks list the same ID.
   - Unit test: retrieve where a chunk references a deleted asset → chunk returned, dropped ID logged, no error.
   - Scope test: tenant A retrieves a global chunk with a global asset → both visible. Tenant A retrieves chunks; a global asset cannot leak into a tenant-scope context unexpectedly.

**Definition of done:**

- `/api/retrieve` returns asset metadata for chunks with linked assets.
- Existing consumers that don't read the new fields are unaffected (additive change).
- Scope isolation still holds.
- `pnpm test` green in the RAG service.

**After completion:** MEMORY.md entry noting (a) the final asset-metadata field list and any fields deliberately omitted from the response, (b) any backwards-compatibility concerns observed.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 39 — Consumer-side display markup: system prompt extension, client parsing, hallucination defense layer

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This adds a new layer to §21.10's hallucination defense (specifically, asset-ID validation), modifies the consumer-facing AI system prompt format, and touches the chat UI's rendering layer. A defect here means either the AI invents image references that the client tries to render (broken UX) or the AI fails to surface images when it should (lost feature value). The hallucination defense in §21.10 is explicitly called out in the spec as security-critical work. Opus.

**Spec references:** Addendum §33.7 (display markup convention), §33.7.4 (hallucination defense layer addition). References existing §21.4 (RAG knowledge block format), §21.10 (hallucination defense layers).

**Prerequisite check:** Prompts 33, 36, 37, 38 committed. The retrieve API returns asset metadata. Chunks with linked assets exist in the dev RAG service.

**Goal:** Wire assets through to the consumer-side chat experience. The AI system prompt is extended to list displayable assets for the current turn. The chat client parses AI output for display markup and renders linked images inline. Asset-ID validation is added as a new layer in the §21.10 defense stack.

**Tasks:**

1. **System prompt extension.** Modify the consumer chat system prompt builder (from Prompt 10 / §21):
   - After the existing RAG knowledge block (§21.4), if any retrieved chunk has `related_asset_ids` and the corresponding asset(s) exist in the retrieve response, append a `DISPLAYABLE ASSETS` block exactly as specified in addendum §33.7.1.
   - The block lists each available asset with its ID, caption, and kind.
   - The `DISPLAY INSTRUCTIONS` immediately follow, telling the AI to use `[[display_asset:<id>]]` markup inline at appropriate points, sparingly, and only from the listed IDs.
   - When no assets are available, the block is omitted entirely — no empty section.

2. **Output parsing on the server.** Create `apps/main/src/lib/ai/parse-display-markup.ts`:
   - Function `parseDisplayMarkup(aiOutput: string, availableAssetIds: string[]): { sanitizedOutput, displayedAssetIds, droppedIds }`.
   - Finds all `[[display_asset:<uuid>]]` matches.
   - For each, checks the UUID against `availableAssetIds`:
     - If valid: replaces the markup with a sentinel like `<asset id="..." />` (or leaves as-is — implementation choice; whichever the client renders).
     - If invalid (AI hallucinated the ID): removes the markup entirely. Adds the ID to `droppedIds`.
   - `droppedIds` is logged to telemetry for prompt-tuning visibility.

3. **Hallucination defense layer addition.** Update `apps/main/src/lib/ai/hallucination-defense/` (the module Prompt 11 created for §21.10):
   - Add a new layer `asset_id_validation`.
   - The layer's check function takes the AI output + the per-turn available asset IDs, returns a `LayerResult` (same shape as existing layers) with `dropped_count` and `dropped_ids` metrics.
   - Wire into the existing layer pipeline. Order doesn't matter much for correctness here (it's local to display markup), but place it after content-safety layers and before final response assembly.
   - Update the §21.10 layer enumeration in the codebase comments / docs to reflect the new layer count.

4. **Client-side rendering.** Modify the consumer chat UI's message renderer:
   - When rendering an AI message, parse for asset sentinels.
   - For each, find the asset in the turn's retrieve response (the chat UI already has this context since it shows source indicators per §21.6).
   - Render an `<img src={public_url} alt={caption} />` inline at the markup position.
   - Apply existing tenant branding / chat styling (image max-width, rounded corners — whatever matches existing media patterns in the UI).
   - Hover/click on the image surfaces the same source-attribution UI as §21.6 text source indicators: source URL, fetched_at, the chunk caption.

5. **Fallback to tool-call shape (conditional).** During dev testing, measure how often the AI emits the inline markup correctly (in available-set, well-formed, at appropriate moments) vs. how often it misses or hallucinates. If reliability is below ~80% on a 50-turn dev test:
   - Implement a fallback: change the system prompt to instruct the AI to use a structured tool call `display_asset({"id": "..."})` instead of inline markup.
   - Implement the tool call handler that injects the image at the call point in the streamed response.
   - The end-user UX is identical; only the wire format differs.
   - **Build-time decision:** which approach ships. Document the choice in MEMORY.md.

6. **Tenant configurability.** §21.6 already establishes that tenants can disable source-display UI. Extend this same toggle to govern image display:
   - If a tenant has source-display disabled, also suppress asset rendering (the AI may still emit markup; the client just doesn't render the image).
   - Document in `tenant_settings` (or wherever the existing source-display toggle lives).

7. **Tests.**
   - Unit tests for `parseDisplayMarkup` covering: zero markups, valid markup, invalid (hallucinated) ID, mixed valid/invalid, malformed markup.
   - Unit test for the hallucination defense layer integrating into the existing pipeline.
   - End-to-end test: dev tenant, user asks "show me deck 7 of Explorer of the Seas" → retrieve returns deck chunk + asset → system prompt includes asset → AI response includes markup → client renders image. Verifiable via Playwright probe.
   - Negative test: AI somehow emits a UUID not in the available set → markup is dropped, no broken image, telemetry logged.

**Definition of done:**

- AI agents reliably emit display markup when an image would help (or, if fallback is used, reliably emit tool calls).
- Hallucinated asset IDs never reach the client.
- Chat UI renders linked images inline with source-attribution UI.
- The new hallucination defense layer is wired in and tested.
- Tenant disable-source-display toggle also disables image rendering.
- `pnpm test` green.

**After completion:** MEMORY.md entry covering (a) whether inline markup or tool-call shape was chosen and why (with reliability numbers from dev testing), (b) the layer position in §21.10's stack, (c) any unexpected interactions with existing layers, and (d) the final asset rendering style (size, position, etc.) so designers and future builders have a reference.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 40 — Price-watch subscriptions: UI, daily Inngest check, threshold logic, notifications

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Addendum §33.8 (price-watch subscriptions, table, lifecycle, daily job, notification target, re-arming, rebooking flow). References §23 (notification routing), §20 (booking widget for rebooking).

**Prerequisite check:** Prompts 33–34 committed (price_watches table exists, PricingDataSource works). The existing §23 notification infrastructure is in place from earlier prompts. The booking widget from §20 / earlier prompts is wired up.

**Goal:** Deliver the subscriber-facing price-watch feature end-to-end. Subscribers create watches with configurable thresholds; a daily job evaluates triggers; triggered watches notify the subscriber; the subscriber can act via the booking widget.

**Tasks:**

1. **API routes.** Create the following in `apps/main/src/app/api/price-watches/`:
   - `POST /` — create a watch. Body: booking_id (optional), sailing identification (line, ship, sail_date, departure_port, cabin_class), threshold config. Validates threshold against `threshold_kind`. Sets `baseline_price` from current `pricing_cache` if available, else returns 422 with a "price data not available for this sailing" error.
   - `GET /` — list watches for the current subscriber (or, for admins, scoped by tenant).
   - `GET /:id` — single watch detail including current cached price for comparison.
   - `PATCH /:id` — update threshold, pause/resume, cancel.
   - `POST /:id/rearm` — reset baseline to current price, set status back to 'active'.
   - All routes use `assertPermission()` per §A.2 multi-tenancy discipline.

2. **Threshold evaluation logic.** Create `apps/main/src/lib/price-watches/evaluate-threshold.ts`:
   - Function `shouldTrigger(watch: PriceWatch, currentPrice: PriceAmount): boolean`.
   - For `threshold_kind: 'dollar_drop'`: `currentPrice <= baseline - dollar_threshold`.
   - For `threshold_kind: 'percent_drop'`: `currentPrice <= baseline * (1 - percent_threshold/100)`.
   - For `threshold_kind: 'either'`: either of the above.
   - Currency mismatch handling: if `baseline_currency != current_currency`, log and skip (don't auto-convert; flag for admin attention).

3. **Daily Inngest function.** Create `apps/main/src/inngest/functions/evaluate-price-watches.ts`:
   - Cron: daily at 04:00 UTC (after the monthly pricing pull's window, well before any user-facing daily traffic).
   - SELECT all `price_watches` with status='active'.
   - Group by `SailingKey` for `PricingDataSource.refreshTrackedSailings()` (use the batching mechanism from Prompt 34).
   - After refresh, for each active watch: read cached price, call `shouldTrigger`. If true:
     - Update watch: status='triggered', triggered_at=NOW().
     - Enqueue a notification event for the subscriber.
   - Respect `PRICE_WATCH_NOTIFICATIONS_ENABLED` kill switch — when off, evaluations still run and statuses update, but notifications are suppressed.

4. **Env var.** Add `PRICE_WATCH_NOTIFICATIONS_ENABLED` (default true) to env validation.

5. **Notification integration.** Add a new notification template per §23:
   - Channel: in-app + email (subscriber's preferences govern).
   - Subject: "Price drop alert: {ship} on {sail_date}".
   - Body: baseline price, current price, dollar/percent drop, booking reference (if attached), a deep link to the booking detail page with a "re-price" CTA.
   - After successful send: update `notified_at` on the watch row.

6. **Subscriber UI: watch creation.**
   - On the booking detail page, add a "Set price watch" action.
   - Modal/form: threshold kind selector (radio: Dollar drop / Percent drop / Either), inputs for dollar threshold and/or percent threshold based on selection.
   - Validation enforces that the selected threshold(s) are filled in.
   - On submit: POST to the API.

7. **Subscriber UI: watch management.**
   - New "Price watches" section in the subscriber's dashboard.
   - List of active, triggered, paused, expired watches with status badges.
   - Per-row actions: pause, resume, cancel, re-arm (for triggered).
   - Click into a watch shows baseline, current price, threshold, fetched_at staleness indicator.

8. **Booking re-price flow.**
   - Triggered watch notification deep-links to the booking detail.
   - The detail page surfaces the alert prominently with the new price.
   - "Adjust booking" button opens the §20 booking widget pre-populated with the customer's existing details, the sailing details, and a flag indicating this is a re-price action (for analytics).
   - The platform does NOT auto-update the booking. The subscriber completes the action in the widget; the booking record updates on widget completion per existing §20 flows.

9. **Coverage handling.** When a subscriber tries to set a watch on a sailing whose line isn't covered by any Apify actor (per Prompt 34's null-return behavior):
   - The watch-creation form surfaces a clear "Price watching isn't available for {line} yet" message.
   - No watch row is created.
   - Logged for platform-admin visibility (to track demand for adding coverage).

10. **Tests.**
    - Unit tests for `shouldTrigger` covering all three threshold kinds and edge cases (exact threshold, currency mismatch).
    - Unit tests for the API routes including permission checks (subscriber A cannot see subscriber B's watches in the same tenant; cross-tenant is blocked at multiple layers).
    - Inngest function dev-trigger test: seed a watch, manually trigger the cron, verify status change and notification enqueued.
    - End-to-end Playwright probe: subscriber creates a watch, manual price update fires the trigger threshold, subscriber receives the notification and the booking detail shows the re-price CTA.

**Definition of done:**

- Subscribers can create, manage, pause, re-arm, and cancel watches via the UI.
- The daily Inngest job evaluates active watches and triggers notifications when thresholds are met.
- The kill switch suppresses notifications without stopping evaluation.
- The re-price flow opens the booking widget with the right pre-population.
- Cross-tenant isolation tested.
- `pnpm test` green.

**After completion:** MEMORY.md entry covering (a) the chosen handling for the currency-mismatch edge case (skip with log is the default; document if changed), (b) any UI patterns reused from existing dashboards, (c) the "uncovered line" messaging used.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — MODEL REMAINS: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 41 — Haiku vision OCR sample evaluation (200-image deck plan sample, gated full-pass decision)

```
═══════════════════════════════════════════════════════════════
MODEL: claude-haiku-4-5-20251001
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Haiku:** This prompt builds a one-off evaluation script — not production runtime code. The script itself can be small and direct. Haiku is the right tool because the script will iterate on Haiku output anyway (the eval is OF Haiku's vision capability), so Claude Code should also be operating at Haiku-tier complexity for the script generation. Cost-efficient, fast. Anything more nuanced from this work belongs in a follow-up Opus or Sonnet prompt once the eval result is in.

**Spec references:** Addendum §33.5 OCR posture (Haiku vision over Tesseract, sampled-first approach), addendum §33.11 step 9 (gated decision).

**Prerequisite check:** Prompts 33, 36, 37 committed. At least 200 deck plan images are stored in `rag_media_assets`. An Anthropic API key with Haiku vision access is in env vars.

**Goal:** Build an offline evaluation script that runs Haiku vision on a 200-image deck plan sample, captures structured output, and produces a human-readable report comparing OCR output against the text descriptions already ingested from the same source pages. The output of this script informs the operator decision on whether to fund a full ~18,000-image OCR pass.

**Tasks:**

1. **Sample selection.** Create `scripts/eval/ocr-deck-plans/select-sample.ts`:
   - Queries `rag_media_assets` for kind='deck_plan'.
   - Selects 200 images stratified across cruise lines (so the sample covers Royal Caribbean, Norwegian, Carnival, etc., not 200 RCL images).
   - Writes the selection to a fixture JSON file with asset_id, ship, deck number, public URL.

2. **OCR run script.** Create `scripts/eval/ocr-deck-plans/run-haiku-vision.ts`:
   - Reads the fixture.
   - For each image: fetches the bytes, calls Haiku vision with a structured prompt asking for: deck-level layout description, identified cabin categories with their location on the deck, identified public venues, any text legends or color keys.
   - Captures: raw model output, total tokens, cost per call.
   - Writes results to a JSONL output file (one line per image, easy to grep and chart).
   - Rate-limits to Anthropic API's standard limits; uses exponential backoff on rate-limit responses.

3. **Comparison report.** Create `scripts/eval/ocr-deck-plans/compare-and-report.ts`:
   - For each OCR'd image: pull the corresponding text chunk that was already ingested from the same deck plan page (text from CruiseMapper).
   - Side-by-side comparison: what the text already says vs. what the OCR adds.
   - For each image, the script computes:
     - Information added by OCR that wasn't in the text (high signal).
     - Information confirmed by both (corroboration but no uplift).
     - Information in OCR that contradicts the text (potential parse error in one source).
   - Aggregates per cruise line and overall.
   - Writes a human-readable markdown report to `reports/ocr-eval-{date}.md` summarizing: total cost, average cost per image, uplift percentage, contradiction percentage, recommended go/no-go with rationale.

4. **Manual review rubric.** Add `reports/ocr-eval-rubric.md` (a static doc) describing what "good enough" means for the operator decision:
   - Suggested threshold: OCR adds meaningful information (cabin location, venue placement, layout shape) on ≥40% of images, with <5% contradiction rate, at <$0.05 per image.
   - These numbers are starting points; operator may adjust before running.
   - The script's report is read alongside this rubric to make the call.

5. **No production changes in this prompt.** The script is an evaluation tool. It does NOT modify chunks, does NOT modify assets, does NOT change the ingest pipeline. The output is the markdown report. The operator decides whether to proceed; a separate follow-up prompt (not in this addendum's sequence) would implement the full OCR pass if approved.

6. **Cost cap.** The eval script has a built-in hard stop at $25 of Anthropic spend regardless of how many images it has processed. Logged loudly when reached.

**Definition of done:**

- Sample selected and committed as fixture.
- Eval script runs end-to-end on the sample.
- Markdown report generated with the comparison and aggregates.
- Total spend on the sample is documented in the report.
- Operator has the data needed to make the go/no-go call.

**After completion:** MEMORY.md entry covering (a) the actual cost per image observed, (b) the uplift percentage, (c) the operator's go/no-go decision and its date, (d) if go, the follow-up prompt that should be written to add OCR to the production ingest.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## Summary of model choices

| Prompt | Title | Model | Rationale |
|---|---|---|---|
| 33 | Schema + storage | Sonnet | Pure DDL + bucket config; no logic. |
| 34 | PricingDataSource + Apify adapter | Sonnet | Adapter pattern with §13 precedent; routine. |
| 35 | CruiseMapper Apify itinerary ingest | Sonnet | Inngest job + actor wrapper; routine. |
| 36 | DIY static ingest (ships + ports) | **Opus** | First DIY scraper; polite-scraping discipline is hard-to-fix-later; machinery reused by Prompt 37. |
| 37 | DIY deck plans + image storage | Sonnet | Extends Prompt 36's machinery to a new content type and adds storage; well-bounded. |
| 38 | RAG retrieve API asset extension | Sonnet | Additive API extension; well-bounded. |
| 39 | Display markup + hallucination defense layer | **Opus** | Adds a §21.10 hallucination defense layer; modifies consumer system prompt and chat UI rendering. |
| 40 | Price-watch subscriptions | Sonnet | Schema + Inngest + notifications + UI; well-trodden. |
| 41 | Haiku vision OCR sample eval | **Haiku** | One-off evaluation script; cost-efficient choice for the work. |

Three Opus prompts? Two — Prompt 36 and Prompt 39. (One Haiku for Prompt 41; the rest Sonnet.)
