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
| Stripe webhook (8 events) | ✅ (apps/main/test/unit/stripe/webhook-error-propagation.test.ts) | ✅ stripe-webhook.error.test.ts | ✅ stripe-webhook.error.test.ts |
| GitHub webhook | ✅ github-webhook.error.test.ts | ✅ | ✅ |
| payouts-execute-transfer | ✅ tryAcquirePayoutLock (other sites: needs cron-internal refactor) | 🔧 | ✅ tryAcquirePayoutLock |
| payouts-reconcile-processing | 🔧 cron-internal refactor | 🔧 | 🔧 |
| abuse-recompute-nightly | 🔧 cron-internal refactor | n/a | 🔧 |
| ai-pricing-cache-refresh | 🔧 cron-internal refactor | n/a | 🔧 |
| Stripe Connect webhook | shares Stripe webhook coverage | shares | ⏳ |
| RAG feedback webhook (apps/rag) | 🔧 needs apps/rag test wiring | 🔧 | 🔧 |
| tenant/billing route | ⏳ | ⏳ | ⏳ |
| tenant/chat-limits route | ⏳ | ⏳ | ⏳ |
| Forums routes | ⏳ | ⏳ | ⏳ |

✅ = covered. ⏳ = handler is testable, just needs the test written.
🔧 = handler needs structural refactor (extract testable inner function,
wire apps/rag vitest config, etc.) before a probe test can attach.
n/a = no external resource dep / no concurrent invocation surface.

### Notes for the next contributor

- **Inngest cron handlers** (`payouts-*`, `abuse-*`, `ai-pricing-*`)
  store their handler inside `inngest.createFunction({...}, async fn)`.
  Inngest does not expose `.fn` publicly across versions, so directly
  invoking the inner async function from a unit test requires either
  (a) extracting the body into a named exported function (the pattern
  used for `tryAcquirePayoutLock`) or (b) running an Inngest dev-server
  shim. Pattern (a) is the cheaper path and is recommended.
- **RAG feedback webhook** lives in `apps/rag` and imports from
  `apps/rag/src/lib/...`. `apps/main/test/error-injection/` is wired to
  `apps/main`'s tsconfig + node_modules; a parallel
  `apps/rag/test/error-injection/` (with its own vitest include and an
  entry in `pnpm test:error-injection`) is the cleanest split.
- **tenant/* routes** use `assertPermission` + `tenantClient` +
  Stripe + Inngest. Mocking surface is large but mechanical. Follow
  the github-webhook.error.test.ts mocking pattern: one `vi.mock`
  block per import, behavior toggled via module-scoped `mock*` vars.

Tracking: `docs/runbooks/audit-followups-2026-05-26.md` "Error-injection
probe — handler coverage" section.
