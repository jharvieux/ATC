# Error-injection probes (D-091 follow-up)

Location: `apps/main/test/error-injection/`. The probes live under
`apps/main/test/` (not `tests/security/`) so vitest can resolve transitive
deps like `stripe` and `@anthropic-ai/sdk` that live in `apps/main/node_modules`.

Tests in this directory force handlers into failure conditions that don't
trigger under normal happy-path testing. Three injection modes per handler:

1. **DB error injection** — Supabase mutation returns `{ data: null, error }`.
   Catches Pattern 1 (unchecked mutations) — handler must surface non-200.
2. **Resource-unavailable injection** — Stripe/Anthropic/Redis/Resend throws.
   Catches Pattern 2 (fail-open on resource error) — handler must fail closed.
3. **Concurrent execution** — fire the same handler twice in parallel.
   Catches Pattern 6 (TOCTOU/CAS) — only one mutation must take effect.

Design doc: `docs/runbooks/error-injection-probe-design.md`.

## Why this directory exists

The probe tests live under `apps/main/test/error-injection/` because
vitest must resolve transitive deps (`stripe`, `@anthropic-ai/sdk`)
that only resolve from `apps/main/node_modules`. Initial attempts to
host the probe under `tests/security/error-injection/` failed because
the root has no `stripe` module and `vi.mock("stripe", ...)` had no
real module to intercept.

`pnpm test:error-injection` runs only the files under this directory.
The probe runs in its own CI step (alongside the regular `pnpm -r test`
step) so a flaky resource-mocked test doesn't block unrelated PRs.

## Actual handler test pattern (#1821, retrofit #1860)

`_helpers.ts` exports a generic `makeFailingDbClient` factory. Every
`*.error.test.ts` file except one rolls its own inline
`vi.mock("@/lib/db/service-role-client", ...)` with a per-table chain
hand-shaped to that handler. That's not drift to fix; it's the real
convention, and it's the right one for most of them: each handler queries a
different set of tables with a different chain shape (single-row lookups,
CAS `.update().eq().select()`, multi-row `.in()` fetches, sequential
mutations that must return different rows depending on the payload). A
generic one-size-fits-all DB mock can express "fail this verb" but not "this
handler's specific branch structure" — every attempt to force a handler onto
a shared factory either loses test fidelity or needs so much per-handler
special-casing that it stops being shared. See
`payouts-execute-transfer.error.test.ts` for a representative example:
`payout_records.update()` needs distinct lock-acquire vs. settle CAS
branches, keyed off the update payload — `makeFailingDbClient` has no way to
express that.

`ai-pricing-cache-refresh.error.test.ts` is the exception: one read
(`select().eq().maybeSingle()`) + one `upsert()`, no branching — the shape
`makeFailingDbClient` was built for. It's wired in there (`vi.mock`'s
factory does `await import("./_helpers")` to fetch it, since the plain
top-level import would be affected by vi.mock hoisting). That probe is the
proof the helper actually works end-to-end; it fails if the helper breaks.

**When adding a new probe:** if your handler has a genuinely simple
one-read/one-write shape like `ai-pricing-cache-refresh`, reach for
`makeFailingDbClient` first. Otherwise copy the existing probe file whose
handler shape is closest to yours (DB-heavy cron vs. webhook-signature
handler vs. Stripe-calling cron — see the Coverage table below) and adapt
its inline mocks.

`_helpers.ts`'s **non-DB** helpers (`makeMockStripeEvent`,
`makeThrowingStripeClass`, `makeStripeConnectionError`,
`invokeInngestFunction`, `makeNoopStep`, `makeThrowingFetch`) don't have this
problem — they're simple and generic. They're just not wired into any probe
today because nothing has needed them yet; reach for them directly when they
fit.

## Running locally

```bash
pnpm test:error-injection
```

## Adding a new handler

1. Add a file `<handler-name>.error.test.ts` here, starting from the
   closest-shaped existing probe (see above) rather than `_helpers.ts`.
2. Cover the three injection modes for each mutation site / external dep.
3. Add a row to the "Coverage" table below.

## Coverage

See `docs/runbooks/error-injection-probe-design.md` for the canonical
priority order. Status per handler is tracked in
`docs/runbooks/audit-followups-2026-05-26.md`.

| Handler | DB-fail | Resource-down | Concurrency |
| --- | --- | --- | --- |
| Stripe webhook (8 events) | ✅ webhook-error-propagation.test.ts | ✅ stripe-webhook.error.test.ts | ✅ stripe-webhook.error.test.ts |
| Stripe Connect webhook | ✅ (shares handler) | ✅ (shares) | ✅ (shares) |
| GitHub webhook | ✅ github-webhook.error.test.ts | ✅ | ✅ |
| payouts-execute-transfer | ✅ payouts-execute-transfer.error.test.ts | ✅ | ✅ tryAcquirePayoutLock |
| payouts-reconcile-processing | ✅ payouts-reconcile-processing.error.test.ts | ✅ | n/a (single-run cron) |
| abuse-recompute-nightly | ✅ abuse-recompute-nightly.error.test.ts (light — staging skip + audit wrapper failure) | n/a | n/a |
| ai-pricing-cache-refresh | ✅ ai-pricing-cache-refresh.error.test.ts | n/a | n/a |
| bookings-stuck-submitting-reconcile | ✅ bookings-stuck-submitting-reconcile.error.test.ts | n/a | ✅ CAS-race test |
| RAG feedback webhook (apps/rag) | ✅ apps/rag/test/error-injection/feedback-webhook.error.test.ts | ✅ | n/a (HMAC-gated) |
| tenant/billing route | deferred | deferred | deferred |
| tenant/chat-limits route | deferred | deferred | deferred |
| Forums routes | deferred | deferred | deferred |

✅ = covered. n/a = no surface for this lane (e.g., HMAC-only webhooks
don't race on insert because they're stateless; single-run nightly crons
can't concurrent-execute under Inngest's per-function lock).
deferred = post-migration the safeAwait + lint-rule combo blocks new
Pattern 1 regressions, so per-handler DB-fail probes are belt-and-suspenders
for these tenant routes. Heavy mocking surface (assertPermission +
tenantClient + Stripe + Inngest) wasn't worth the additional safety. Pick
back up only if a tenant-route regression slips past lint.

### Notes for the next contributor

- **Inngest cron handlers** that need probes: extract the body into a
  named exported function (the `tryAcquirePayoutLock` / `runPayoutsExecuteTransfer`
  precedent). Inngest doesn't publicly expose `.fn` across versions; direct
  invocation of the named export is the cheapest path.
- **apps/rag probes** live in `apps/rag/test/error-injection/` and run
  via `pnpm test:error-injection`. The script does a 2-step run:
  `vitest run apps/main/test/error-injection && pnpm --dir apps/rag exec vitest run test/error-injection`.
  The split exists because each app has its own tsconfig path aliases
  and node_modules.
- **tenant/* routes** if needed: follow the github-webhook.error.test.ts
  pattern. One `vi.mock` block per import, behavior toggled via
  module-scoped `mock*` vars (vitest hoists vi.mock; only `mock`-prefixed
  identifiers can be referenced inside the factory).

Tracking: `docs/runbooks/audit-followups-2026-05-26.md` "Error-injection
probe — handler coverage" section.
