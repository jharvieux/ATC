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

## Why this is a separate test directory

- `apps/main/test/` is the standard unit-test home. Tests there run in
  every PR's CI job and must pass quickly.
- `tests/security/error-injection/` is dedicated to failure-mode coverage
  that exercises the same handlers under injected failures. It runs in
  its own CI job (`pnpm test:error-injection`) so a flaky resource-mocked
  test doesn't block unrelated PRs while we tune it.

## Canonical handler test pattern

```typescript
// tests/security/error-injection/<handler-name>.error.test.ts
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
| Stripe webhook (8 events) | ✅ (apps/main/test/unit/stripe/webhook-error-propagation.test.ts) | ⏳ | ⏳ |
| payouts-execute-transfer | ✅ tryAcquirePayoutLock | ⏳ | ✅ tryAcquirePayoutLock |
| payouts-reconcile-processing | ⏳ | ⏳ | ⏳ |
| abuse-recompute-nightly | ⏳ | n/a | ⏳ |
| ai-pricing-cache-refresh | ⏳ | n/a | ⏳ |
| RAG feedback webhook | ⏳ | ⏳ | ⏳ |
| GitHub webhook | ⏳ | ⏳ | ⏳ |
| Stripe Connect webhook | shares Stripe webhook coverage | ⏳ | ⏳ |
| tenant/billing route | ⏳ | ⏳ | ⏳ |
| tenant/chat-limits route | ⏳ | ⏳ | ⏳ |
| Forums routes | ⏳ | ⏳ | ⏳ |

✅ = covered. ⏳ = work-in-progress / not yet added. n/a = no external
resource dep / no concurrent invocation surface for this handler.
