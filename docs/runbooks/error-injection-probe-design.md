# Error-injection probe — design doc (D-091)

## Why this exists

The Greptile audit (2026-05-26) found patterns that **don't fail under normal testing** because the failure mode requires an infrastructure-level error:

- **Unchecked Supabase mutations** (Pattern 1, ~113 sites): every happy-path test passes; silent failure only triggers when Supabase JS returns `{ error }` instead of `{ data }`.
- **Fail-open on resource error** (Pattern 2): rate limit / signature check returns "allow" when Redis or another dependency is unreachable. Co-occurs with broader incidents that aren't simulated in tests.
- **TOCTOU stale-reads** (Pattern 6): budget gates pass under sequential test runs but break under concurrent runs.

Existing `cross-tenant-probe.test.ts` covers cross-tenant authz comprehensively but doesn't cover these failure modes.

## What an error-injection probe would do

For each handler in scope, run the handler under three injected failure conditions:

1. **DB error injection**: every `await db.from(...).update/insert/delete/upsert(...)` returns `{ data: null, error: { code: "23505", message: "synthetic" } }` once.
   - **Assert**: handler returns non-200 (signaling external system to retry).
   - **Assert**: handler does NOT continue past the failed mutation as if it succeeded.
   - **Catches**: Pattern 1 (unchecked mutations).

2. **Resource-unavailable injection**: every external resource (Redis, Stripe, Anthropic) throws on connect.
   - **Assert**: handler fails-closed (rejects request or returns 5xx, never 200 with `{ allowed: true }`).
   - **Catches**: Pattern 2 (fail-open on resource error).

3. **Concurrent execution**: fire the same handler twice in parallel with the same payload.
   - **Assert**: only one mutation succeeds (idempotency via DB constraint or advisory lock).
   - **Assert**: combined cost / quota effect respects the gate (no double-spend).
   - **Catches**: Pattern 6 (TOCTOU + concurrent overlap).

## Scope — which handlers

Tier 1 (every Stripe webhook event handler + Inngest cron):
- `apps/main/src/lib/stripe/webhook-handler.ts` (each switch case)
- `apps/main/src/inngest/payouts-execute-transfer.ts` (real money)
- `apps/main/src/inngest/payouts-reconcile-processing.ts` (real money)
- `apps/main/src/inngest/abuse-recompute-nightly.ts` (state mutation)
- `apps/main/src/inngest/ai-pricing-cache-refresh.ts` (state mutation)
- All other inngest crons that write state

Tier 2 (cross-service webhooks):
- `apps/rag/src/app/api/feedback/route.ts` (HMAC-verified writes)
- `apps/main/src/app/api/webhooks/github/route.ts` (issue lifecycle)
- `apps/main/src/app/api/webhooks/stripe/connect/route.ts`

Tier 3 (tenant-facing API mutations):
- `apps/main/src/app/api/tenant/billing/route.ts` (D-091 punch list line 13/15/18)
- `apps/main/src/app/api/tenant/chat-limits/route.ts`
- Forums routes (D-091 punch list)

## How to implement (sketch)

The cleanest approach uses Vitest's `vi.mock` to swap `createServiceRoleClient` at the module level. For each handler:

```typescript
// tests/security/error-injection/stripe-webhook-payout-paid.test.ts
import { describe, it, expect, vi } from "vitest";

// Inject: every `update()` returns a synthetic error.
const failingUpdate = vi.fn(() => Promise.resolve({
  data: null,
  error: { code: "PGRST500", message: "synthetic db error" },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      update: () => ({ eq: failingUpdate }),
      insert: () => ({ select: () => ({ single: failingUpdate }) }),
      // ... other methods as needed
    }),
  }),
}));

import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

describe("Stripe webhook — error injection (Pattern 1)", () => {
  it("returns 500 when DB update fails on transfer.paid", async () => {
    const req = makeMockStripeWebhookRequest("transfer.paid", { ... });
    const res = await handleStripeWebhook(req, "platform");
    expect(res.status).toBe(500);   // ← currently FAILS (returns 200)
    expect(failingUpdate).toHaveBeenCalled();
  });
});
```

The `expect(res.status).toBe(500)` is what proves the handler doesn't silently swallow the error. **This test, written today, would fail for every one of the 7 unchecked-update sites in `webhook-handler.ts`** — confirming Greptile's finding empirically.

## Reusable test helpers needed

To keep the per-handler test files small, build:

- `makeFailingDbClient(failingMethods: string[])` — returns a Supabase-shaped mock with the named methods returning errors.
- `makeMockStripeRequest(eventType, payload)` — signs and packages a Stripe webhook request.
- `makeMockInngestRequest(eventName, data)` — packages an Inngest event for direct handler invocation.
- `injectResourceUnavailable(resource: 'redis' | 'stripe' | 'anthropic' | 'resend')` — patches the respective module to throw.

These belong in `tests/security/error-injection/_helpers.ts`.

## Why this is its own PR

A real implementation is a multi-day project:

- ~15-25 handlers to cover
- 3 injection modes per handler = 45-75 test cases
- Reusable mocking infrastructure
- CI integration (likely a new workflow job similar to `Cross-Tenant Probe`)

This is more effort than the rest of the D-091 work combined. Calling it out as a follow-up rather than half-implementing it.

## Pre-work alternative — concrete unit-test pattern

Until the full probe lands, ship one concrete error-injection unit test per Greptile-flagged P1 site as part of the fix PR for that finding. Each fix-PR for the 7 unchecked-update sites in Stripe should include:

```typescript
it("returns 500 when DB update fails on <eventType>", async () => {
  // ... mock failing update
  // ... assert response.status === 500
});
```

That's natural-scope per fix and gives the operator immediate confidence each fix actually closes the gap.

## Future work checklist

- [ ] Build `tests/security/error-injection/_helpers.ts` with the 4 helpers above.
- [ ] Cover Tier 1 handlers (Stripe webhook + payout crons).
- [ ] Cover Tier 2 (cross-service webhooks).
- [ ] Cover Tier 3 (tenant API mutations).
- [ ] Wire a new CI job that runs `pnpm test:error-injection`.
- [ ] Cross-tenant probe extension: add "wrong-tenant body, right-tenant JWT" test mode to catch the body/JWT mismatch defense-in-depth check broadly.
