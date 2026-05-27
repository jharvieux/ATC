# Anti-patterns (D-091)

Recurring bug-class patterns identified in the 2026-05-26 Greptile audit. Each pattern has a preventive mechanism (ESLint rule, slop-check pattern, doctrine line, or test probe).

## 1. Stub-shaped code

**Symptom**: a function's signature or shape suggests one behavior; the body silently delivers a subset.

**Examples**:
- `getPublicKey(kid)` accepts a kid arg but ignores it and returns the same PEM
- `withPlatformAdminAudit` "supports" nested calls but skips the friction gate when nested
- Custom JS `timingSafeEqual` looks constant-time but JIT can break the guarantee
- `else if (Object.keys(updates).length > 0)` branch that is always-false dead code

**Why slips through review**: code compiles, type-checks, and passes happy-path tests because the stub matches the right shape. Detection requires reading parameters vs body.

**Prevention**:
- **Doctrine** (CLAUDE.md): "If a function takes a parameter, every parameter must affect output. Stub args are slop."
- **Slop-check**: `unused-parameter-detector` — flag function parameters never referenced in the body.
- **Doctrine**: when reviewing, ask "could this function be replaced with one that has fewer parameters and identical behavior?" If yes, the extras are stubs.

## 2. Fail-open when the enforcement layer goes down

**Symptom**: a defense-in-depth layer returns "permit" when it can't run (Redis down, DB error, secret unset).

**Examples**:
- Rate limit returns `{ allowed: true }` when Redis is unreachable
- Stripe webhook returns 200 even when DB update silently fails — Stripe stops retrying
- Missing `stripe-signature` header passed as empty string to constructEvent

**Why slips through**: the failure mode correlates with broader infra incidents that aren't covered in normal testing.

**Prevention**:
- **ESLint** (opt-in): `atc/no-fail-open-on-resource-error` — flag catch blocks returning `{ allowed: true }`, `{ ok: true }`, or 200 without re-throw/log.
- **Doctrine** (CLAUDE.md): "Fail-closed by default. When an enforcement layer is unreachable, the answer is denial, not permission. Failing open at the worst moment is the worst failure mode."
- **Probe**: error-injection probe that fires DB errors mid-handler and asserts the response is 500 (not 200).

## 3. Unchecked Supabase mutations

**Symptom**: `await db.from(x).update(y).eq(z)` is awaited but the `{ data, error }` tuple is discarded. Supabase JS v2 does NOT throw on DB errors — silent failure is the default.

**Examples**: 113 sites across the codebase. Most concentrated in `apps/main/src/app/api/forums/*`, `apps/main/src/app/api/tenant/*`, and `apps/main/src/lib/stripe/webhook-handler.ts`.

**Why slips through**: every happy-path test passes; the silent-failure path only triggers under DB-level errors not present in dev.

**Prevention**:
- **ESLint**: `atc/no-unchecked-supabase-mutation` — flag any `await ...update/insert/delete/upsert(...)` whose result isn't destructured to check `error`. Ships at `warn` initially; flip to `error` after the existing 113-site cleanup.
- **Doctrine**: "Supabase JS v2 doesn't throw. Every mutation must destructure `{ error }` and return non-200 on truthy error."

## 4. Credentials in URL query strings

**Symptom**: external API call constructs the URL with `?token=...` or `?api_key=...` instead of using an `Authorization: Bearer` header.

**Examples**:
- `apify-pricing-adapter.ts:226` — Apify token in URL
- `cruisemapper-actor.ts:102` — same pattern

**Why slips through**: the request succeeds; the leak surface (proxy logs, error messages embedding URL) is invisible until reviewed.

**Prevention**:
- **ESLint**: `atc/no-credentials-in-url` — flag template-literal URL construction containing `?token=`, `?api_key=`, `?secret=`, `?password=`.
- **Doctrine**: "External API credentials always go in headers, never query strings. Headers are routinely scrubbed from access logs; URLs are not."

## 5. App-layer scope check without DB-layer enforcement

**Symptom**: a tenant-scoped query bypasses RLS (via service-role client) and relies on a single application-layer scope check.

**Examples**:
- `rag_media_assets` query in `/api/retrieve` — service-role + app-layer scope check, no SQL `WHERE tenant_id = ?`
- `assert-platform-admin.ts` and `factories.ts` use service-role without an explicit ESLint exemption
- `feedback` endpoint inserts rows without a `tenant_id` column at all

**Why slips through**: the app-layer check looks complete in the code. The fact that RLS isn't a second layer requires reading the client type.

**Prevention**:
- **Doctrine**: "Every tenant-scoped query should have BOTH an app-layer filter AND a DB-layer constraint (RLS via tenantClient, or an explicit `.eq("tenant_id", ...)` on the service-role query). If only one exists, the code MUST comment why."
- **Probe**: extend `cross-tenant-probe` to fire each known service-role endpoint with a wrong-tenant body and assert the response is rejected before DB write.

## 6. TOCTOU / stale-read in budget or limit gates

**Symptom**: a gate reads a quota value, then the caller consumes that quota across multiple operations without re-reading.

**Examples**:
- Apify monthly budget read once at run start, not re-checked between 9 line batches
- `estimated_skipped` rows write phantom spend that inflates the cap
- Forensics access counter non-atomic read-modify-write (related class)

**Why slips through**: sequential single-run tests pass. Catching requires concurrent or multi-batch test cases.

**Prevention**:
- **Doctrine**: "Quota gates must re-read between consuming operations. If two crons can overlap, the gate must be atomic at the DB level (advisory lock or transactional reserve-row)."
- **Slop-check** (opt-in): `stale-budget-read-detector` — flag patterns where a value is read once outside a loop, and the loop body consumes that resource without re-reading.
- **Probe**: error-injection probe also runs a "concurrent execution" mode that fires the same cron twice and asserts the budget cap is respected.

---

## How this catalog gets used

- **At authoring time**: the CLAUDE.md doctrine lines (added to the "Things to be wary of" section) shape what gets written. Re-read every session.
- **At lint time**: ESLint rules in `packages/config/eslint-rules/` catch the mechanical patterns. Some default `error`, some opt-in `warn`.
- **At diff time**: `pnpm slop-check` (D-091) extends to cover these patterns where reasonable. Posts advisory PR comments.
- **At CI time**: `cross-tenant-probe` and the new `error-injection-probe` catch the runtime-only failure modes.

## Adding a new pattern

1. Confirm it's a pattern (≥ 2 instances in real findings).
2. Add to this catalog with: symptom, examples, why-slips-through, prevention.
3. Implement the cheapest prevention layer first (doctrine line → ESLint → slop-check → probe). Add layers only if simpler ones don't catch.
4. Backfill: grep the codebase for existing instances and either fix them or document waivers.
