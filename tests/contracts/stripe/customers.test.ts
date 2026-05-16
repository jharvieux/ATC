/**
 * Contract tests — Stripe customers
 *
 * These tests verify that the application's Stripe wrapper functions produce
 * the correct API calls and handle responses correctly. The MSW server
 * replays committed fixture responses — no real Stripe calls are made.
 *
 * TODO: Replace skip blocks with real assertions once Stripe wrapper
 * functions exist in src/lib/stripe/.
 */

import { describe, it, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "../setup";

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Stripe / customers", () => {
  it.skip("createCustomer — returns customer object with id and email", async () => {
    // TODO: implement once src/lib/stripe/customers.ts exists
    // const result = await createCustomer({ email: "test@example.com", tenantId: "tenant_test_001" });
    // expect(result.id).toMatch(/^cus_/);
    // expect(result.email).toBe("test@example.com");
  });
});

describe("Stripe / subscriptions", () => {
  it.skip("createSubscription — returns active subscription", async () => {
    // TODO: implement once src/lib/stripe/subscriptions.ts exists
  });

  it.skip("cancelSubscription — returns canceled subscription", async () => {
    // TODO: implement once src/lib/stripe/subscriptions.ts exists
  });
});

describe("Stripe / connect", () => {
  it.skip("createConnectAccount — returns account with id", async () => {
    // TODO: implement once src/lib/stripe/connect.ts exists
  });

  it.skip("createOnboardingLink — returns url", async () => {
    // TODO: implement once src/lib/stripe/connect.ts exists
  });
});
