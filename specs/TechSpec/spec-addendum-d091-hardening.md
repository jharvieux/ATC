# Spec Addendum — D-091 Hardening

**Status:** Active. This addendum captures the architectural and operational changes adopted
between 2026-05-25 and 2026-05-27 in response to three rounds of Greptile security audits
(15 PRs, ~90 findings, 18 recurring patterns). The original spec sections remain authoritative;
this document records the deltas that supersede or extend those sections.

**Owner:** Platform engineering.
**Cross-refs:** `MEMORY.md` D-091/D-091b/D-092/D-093/D-094/D-095/D-096; `docs/runbooks/anti-patterns.md`;
`docs/runbooks/audit-followups-2026-05-26.md`; `docs/runbooks/error-injection-probe-design.md`.

---

## 1. Why this addendum exists

The spec describes the *intended* behavior of each subsystem. The audits surfaced a class of
*latent bugs* that arose not from misreading the spec but from the JS/TS expression of it —
specifically:

- **Supabase JS v2 does not throw on DB errors.** Every `await db.from(...).update(...)`
  silently discarded its `{ error }` tuple unless explicitly destructured. ~113 sites.
- **Chained `.eq()` matchers on UPDATE return `{ error: null, data: null }` when zero rows match.**
  CAS-style status guards looked like they succeeded when they didn't. ~5 confirmed sites.
- **`void` async calls die mid-serverless** before the work completes.
- **Resource-unavailable failures (Redis down, vendor outage) defaulted to "allow"** in several enforcement
  gates, when fail-closed is the correct posture.

These patterns are not visible in any single line of code; they emerge across multi-step flows.
The fix is *structural*: new helpers, new doctrine, new lint rules, and a new error-injection probe
that exercises every Tier-1 handler under DB-fail / resource-down / concurrency conditions.

---

## 2. New architectural primitives

### 2.1 `safeAwait` wrapper (D-094)

Path: `apps/main/src/lib/db/safe-mutation.ts`.

`safeAwait(query, "context.label")` is now the canonical way to issue a Supabase mutation.
It awaits the query, throws a structured `SupabaseMutationError` if `{ error }` is truthy,
and returns the unwrapped `data` otherwise. Helpers:

- `unwrap(result, context)` — sync unwrap of an already-awaited tuple.
- `unwrapRequired(result, context)` — asserts non-null data.
- `safeAwait(query, context)` — the common case.
- `safeAwaitRowCount(query, context, expectedCount)` — for CAS-style status-guarded updates
  that chain `.select("id")` to verify the affected row count.

The ESLint rule `atc/no-unchecked-supabase-mutation` is now `error`-level repo-wide after the
migration PRs landed (#271 inngest / #272 api routes / #273 lib).

**Doctrine** (CLAUDE.md — "Check every Supabase mutation"):

> Every `await db.from(...).update/insert/delete/upsert(...)` must either be wrapped in
> `safeAwait(...)` or destructure `{ error }` and surface non-200 on truthy error.

### 2.2 Conversation history helper (D-095)

Path: `apps/main/src/lib/chat/conversation-history.ts`.

`loadConversationHistory(db, tenantId, conversationId, options?)` returns the user+assistant
turns for a conversation in chronological order, trimmed to a 50k-char budget (oldest first),
with the alternation guard that collapses consecutive same-role turns to the latest (Anthropic
rejects non-alternating histories with 400).

**Two-layer isolation:** the helper requires `tenantId` as a positional argument and uses both
`.eq("tenant_id", ...)` AND `.eq("conversation_id", ...)`. The service-role client bypasses
RLS, so the db-layer filter restores the second isolation layer.

**Used by:**
- `apps/main/src/app/api/chat/route.ts` — customer chat (loaded once after persisting the user
  message; reused across regen attempts to avoid feeding in-progress drafts back).
- `apps/main/src/app/api/help/sessions/[id]/message/route.ts` — help-AI (when
  `session.conversation_id` is set; admin-source sessions stay single-turn pending the deeper
  help-AI persistence work).

### 2.3 Atomic increment RPC (D-094 follow-up)

Path: `apps/main/supabase/migrations/20260627000000_tenant_usage_atomic_increment.sql`.

`increment_tenant_ai_cost(tenant_id, billing_period, amount_cents)` is a `SECURITY DEFINER`
function with `search_path = ''` that performs an atomic
`INSERT … ON CONFLICT DO UPDATE SET ai_cost = old + new`. Replaces the prior read-then-write
TOCTOU in `lib/ai/call-wrapper.ts:logAndIncrement` that — after `safeAwait` started surfacing
errors — would make a successful AI call appear to fail under concurrent first-period inserts.

EXECUTE is revoked from PUBLIC and granted only to `service_role`. Match the §5.1.1
SECURITY-DEFINER doctrine.

### 2.4 Error-injection probe (D-091 follow-up)

Path: `apps/main/test/error-injection/`. Runs as a dedicated CI step
(`pnpm test:error-injection`) alongside lint/typecheck/build.

Forces handlers into failure conditions that don't fire under happy-path testing:

1. **DB error injection.** Supabase mutation returns `{ data: null, error }`. Handler must
   surface non-200.
2. **Resource-unavailable injection.** Stripe / Anthropic / Redis throws on connect. Handler
   must fail closed.
3. **Concurrent execution.** Same handler fires twice in parallel. Idempotency / CAS must hold.

Coverage table is maintained in `apps/main/test/error-injection/README.md`.

---

## 3. New doctrine bullets

Adopted in `CLAUDE.md`. Each was added with a "Why" anchor and a "How to apply" pattern.
These bullets bind ALL future code, not just the audit-fix PRs.

1. **No stub-shaped code (D-091).** If a function takes a parameter, every parameter must
   affect the output. No dead branches.
2. **Fail-closed by default (D-091).** Resource error → deny. Returning `{ allowed: true }`
   on Redis error is the worst failure mode (silent AND disables retries).
3. **Check every Supabase mutation (D-091/D-094).** Use `safeAwait(...)` or destructure
   `{ error }`. Lint-enforced repo-wide.
4. **Two layers of tenant isolation (D-091).** Tenant-scoped queries need BOTH app-layer
   filter AND db-layer constraint (RLS via `tenantClient`, or explicit `.eq("tenant_id", ...)`).
5. **External credentials in headers, never URLs (D-091).** Proxy/CDN/APM logs scrub headers,
   not URLs.
6. **Quota gates re-read between consuming ops (D-091).** Budget gates re-check or use
   DB-atomic reserve-row patterns.
7. **CAS-style status-guarded updates need row-count verification (D-091 round 2).** Chain
   `.select('id')` and assert the returned array length matches the expected count, or use
   `safeAwaitRowCount(...)`.
8. **Never `void` an async call in serverless without a justifying comment (D-091 round 2).**
9. **One `assertPermission` call per semantic operation (D-091 round 2).** Multi-action routes
   call `assertPermission` separately per (resource, action).
10. **Idempotency rows written AFTER dispatch (D-091 round 2).** A row's existence means
    "fully processed," not "received." Use a separate `processing_started_at` if reconcile
    needs to recover stuck rows.
11. **State-machine transitions validate inputs at the function boundary (D-091 round 2).**
12. **Webhook signature encoding captured at integration time (D-091 round 2).** A recorded
    signature fixture + test prevents a future refactor flipping the encoding.

---

## 4. Section-by-section deltas

### §5.4 Database access patterns

Adds: `safeAwait` / `safeAwaitRowCount` are the only sanctioned ways to issue Supabase
mutations. The previously-allowed pattern `await db.from(...).update(...)` (destructured
result) is **disallowed** by lint going forward except in `safe-mutation.ts` itself.

### §7.9a Stripe webhook handler contract

Adds: every event-type handler MUST destructure `{ error }` from any DB mutation and throw
from inside the dispatch `try`. The outer catch sets `processing_outcome='error'` and
returns 500. The error-injection probe covers all 8 event branches plus the resource-down
and concurrency lanes.

### §10.6 AI kill switch

No spec change. The audit found the streaming-mode kill switch was checked AFTER the
stream started; round-3 fix #43 moves the check to before the stream is acquired (still
pending implementation as of this addendum).

### §14.7 Stripe Connect transfer cron

Adds: `tryAcquirePayoutLock(db, payoutId)` is the exclusive way to transition a payout
record from `available` → `processing`. It chains `.select('id')` after the CAS update
and asserts row count > 0; if the lock isn't acquired, the row is skipped. The error-
injection probe covers the lock + reconciliation cron error lanes.

Both `payouts-execute-transfer` and `payouts-reconcile-processing` now export their inner
body as a named function (`runPayoutsExecuteTransfer`, `runPayoutsReconcileProcessing`) so
the probe can invoke them directly without an Inngest dev-server shim. Same pattern for
`abuse-recompute-nightly` and `ai-pricing-cache-refresh`.

### §15.6 / §15.8 / §15.16 Stripe subscription events

Adds: every event-type handler in `lib/stripe/webhook-handler.ts` now uses `safeAwait` for
its mutations. Same probe coverage as §7.9a.

### §17.9 / §17.10 / §25.4a CCPA data export + purge

Adds:
- **Export allowlist (#46).** `inngest/user-data-export-build.ts` uses explicit column
  allowlists for users, conversations, bookings, legal_consents. `select('*')` is no longer
  used — internal columns (tenant_id, deleted_at, audit timestamps, RLS-internal flags)
  are excluded from the user-facing export.
- **Purge multi-tenant fix (#45).** `inngest/user-data-purge-after-grace.ts` re-reads the
  user row by the PK `user_id` (which the event payload carries) rather than `auth_user_id`.
  `maybeSingle()` previously silently returned null when the auth user existed in multiple
  tenants (each tenant has its own users row), so multi-tenant users were never purged.

### §22.4 Stage 2 — Tolerable-PII redaction

Adds: `lib/rag-ingest/haiku-pii-redact.ts` now returns
`{ status: 'failed', reason }` on missing `ANTHROPIC_API_KEY`, on vendor exception, and on
empty model response — replacing the prior fail-OPEN behavior that returned `{ status: 'clean' }`
on those branches. The caller (`inngest/rag-pii-redact.ts`) treats `failed` as a quarantine
signal: writes `pii_redaction_status='quarantined'`, runs the aggregation alert path, and
does NOT emit `rag.submission_ready_for_normalization`.

The regex prefilter (zero-tolerance SSN / credit card / passport) continues to run upstream
and remains the safety-critical first line.

### §24 Chat backend

Adds:
- **Multi-turn history (#42).** Customer chat and help-AI chat now use
  `loadConversationHistory` to pull prior user+assistant turns. The previous
  `messages: [{role:"user", content: userMessage}]` pattern was single-turn / stateless on
  every call.
- **Two-layer tenant filter.** Loading history requires `tenant_id` so the service-role
  client doesn't bypass tenant isolation.
- **Alternation guard.** `trimToBudget` collapses consecutive same-role turns to the
  latest in each run (Anthropic rejects non-alternating histories).

### §27.12 AI cost wrapper

Adds: `lib/ai/call-wrapper.ts:logAndIncrement` now calls the atomic
`increment_tenant_ai_cost` RPC instead of a read-then-write. See §2.3 above.

### §32 Self-service help

No spec change. The audit-found webhook + help-AI bugs are scoped fixes already documented
in the prior addendums.

---

## 5. Test infrastructure changes

### 5.1 ESLint rules (D-091 / D-091b)

| Rule | Severity | Notes |
|---|---|---|
| `atc/no-unchecked-supabase-mutation` | `error` | Repo-wide after migration PRs #271/#272/#273. |
| `atc/no-credentials-in-url` | `error` | Forces credentials to live in `Authorization:` header. |
| `atc/no-fail-open-on-resource-error` | `off` (opt-in) | Heuristic; manual review recommended. |
| `atc/no-orphan-todo` | `error` | Forces `TODO(owner)` or `TODO(#123)`. |
| `atc/no-narrating-comments` | `off` (opt-in) | Slop-detection heuristic. |
| `atc/no-direct-anthropic-or-openai-import` | `error` | Only `lib/ai/call-wrapper.ts` can import vendor SDKs. |
| `atc/no-direct-service-role-import` | `error` | Allowlist of files; webhook handlers + admin tools. |

### 5.2 Error-injection probe directory

Path: `apps/main/test/error-injection/`. Imports work from there because vitest resolves
transitive deps like `stripe` and `@anthropic-ai/sdk` against `apps/main/node_modules`.
The probe was originally placed under `tests/security/error-injection/` (matching the
cross-tenant probe layout) but `vi.mock("stripe", ...)` couldn't intercept the handler's
transitive import from the root.

### 5.3 Slop-check workflow

`pnpm slop-check` plus the GitHub Actions workflow that runs against every PR's diff.
Catches the most common LLM-generated-code anti-patterns (narrating comments, single-use
helpers, defensive validation against impossible inputs, etc.). Runs in <2s.

### 5.4 Migration script

`scripts/codemod-safe-await.py` — used to mechanically wrap unchecked Supabase mutations
across the codebase during the D-094 migration. Kept in-tree so future migrations
(re-enabling the rule across new code, or a future similar wrapper) can re-use the same
machinery. Conservative: skips await expressions that are already wrapped, destructured,
returned, or assigned.

---

## 6. Anti-pattern catalog (cross-round totals)

Maintained in `docs/runbooks/anti-patterns.md`. 18 patterns identified across 15 audits.
See that doc for the canonical descriptions; this addendum cites the patterns by number
where relevant.

The top-5 by audit frequency:

| # | Pattern | Audits flagged | Mitigation |
|---|---|---|---|
| 1 | Unchecked Supabase mutation | 15/15 | `safeAwait` + lint rule (D-094) |
| 5 | App-layer-only tenant scoping | 10/15 | Two-layer doctrine + audit |
| 6 | TOCTOU race | 7/15 | Re-check between ops; atomic RPC for counters |
| 7 | Zero-row CAS update | 6/15 | `safeAwaitRowCount` + `.select("id")` chain |
| 8 | `void` async / stateless LLM | 5/15 | Doctrine + chat conversation history (D-095) |

---

## 7. Procedure changes

### 7.1 Read every Greptile review before merging (D-093)

Greptile posts review comments inline on PRs. They are NOT a required CI check, but
multiple P1 findings in this session would have leaked past merge without explicit
review. Procedure:

1. Fetch the Greptile review via `gh api repos/jharvieux/ATC/issues/<PR>/comments`.
2. Read the "Greptile Summary" and "Outside Diff" sections.
3. For each finding, decide:
   - **Fix in this PR** — preferred when small + in scope.
   - **Defer + ticket** — log on the audit-followups punch list.
   - **Wontfix + comment** — when the finding is wrong or context-missing.
4. Resolve before merge.

### 7.2 Migration sequencing

When a structural change (new helper, doctrine bullet, lint rule flip) is large enough to
touch many files, split into:

1. **Helper PR** — adds the wrapper / type / function. Standalone tests.
2. **Doctrine PR** — updates `CLAUDE.md` + adds the ESLint rule at severity `off`.
3. **Migration PRs** — mechanical migration grouped by directory. Each runs codemod +
   typecheck + lint + tests, opens PR, auto-merges on green.
4. **Rule flip PR** — bumps the ESLint rule from `off` to `error` after all migrations land.
   Smallest possible PR; verifies the migration is complete.

This sequence ran for the D-094 `safeAwait` rollout in 5 PRs (#265, #271, #272, #273, and
the rule-flip PR queued separately).

---

## 8. Open items / deferred

- **`atc/no-void-async-without-comment`** — sketched but not implemented; deferred until
  the operator wants a one-pass audit.
- **`atc/state-machine-input-must-be-literal`** — same.
- **Error-injection probe expansion** — Tier-2/3 handlers still need coverage. Tracked in
  `apps/main/test/error-injection/README.md`.
- **Help-AI assistant-turn persistence** — help-AI doesn't write its own user/assistant
  rows to `messages`, so within-help-AI multi-turn context is still single-turn after the
  initial customer_chat → help-AI handoff. Decision needed: should help-AI turns count
  toward chat metrics? What tenant scoping for admin-source sessions?
- **Round-3 Tier-1 punch list** — items #43, #47-#53, #56, #58 still need implementation.
  Tracked in `docs/runbooks/audit-followups-2026-05-26.md`.

---

## 9. Versioning

This addendum is point-in-time as of 2026-05-27. Subsequent changes that touch the same
subsystems should update or supersede the relevant section here. When a section is
fully absorbed back into the main spec (e.g., when §27.12 is rewritten to describe the
RPC), that section in this addendum should be marked `[absorbed into §<N>]` rather than
deleted.
