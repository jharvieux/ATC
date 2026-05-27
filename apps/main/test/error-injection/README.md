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

## Canonical handler test pattern

```typescript
// apps/main/test/error-injection/<handler-name>.error.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFailingDbClient, makeMockStripeEvent, makeMockStripeWebhookRequest } from "./_helpers";

// vi.mock is hoisted — declare it at module level. Behavior is toggled
// via module-scoped variables.
let dbOpts: Parameters<typeof makeFailingDbClient>[0] = {};

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => makeFailingDbClient(dbOpts),
}));

let mockEvent: ReturnType<typeof makeMockStripeEvent>;

vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = {
      constructEvent: (_body: string, _sig: string, _secret: string) => mockEvent,
    };
    errors = { StripeError: class extends Error {} };
  },
}));

import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  dbOpts = {};
  mockEvent = makeMockStripeEvent("transfer.paid", { id: "tr_1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe webhook — error injection", () => {
  it("returns 500 when update fails on transfer.paid (Pattern 1)", async () => {
    const counter = { value: 0 };
    dbOpts = { fail: ["update"], selectResult: { data: [{ id: "p-1" }] }, callCount: counter };
    const res = await handleStripeWebhook(makeMockStripeWebhookRequest("transfer.paid"), "platform");
    expect(res.status).toBe(500);
    expect(counter.value).toBeGreaterThan(0);
  });
});
```

## Running locally

```bash
pnpm test:error-injection
```

## Adding a new handler

1. Add a file `<handler-name>.error.test.ts` here.
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
