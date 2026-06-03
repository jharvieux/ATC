// Contract: verifies Stripe API response shapes the app depends on.
// MSW replays the recorded fixtures so no live secret key is needed.
//
// Why raw fetch rather than the Stripe SDK: Stripe SDK v22 uses an HTTP
// client path that MSW v2's interceptors don't cover (tests timed out).
// Raw fetch is intercepted by MSW and verifies the same contract: that
// the recorded fixture shapes parse correctly. If a fixture shape drifts
// from what billing/onboarding code expects, the assertions below fail.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "../setup";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function stripePost(path: string, body: Record<string, string>) {
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_test_placeholder",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
}

describe("Stripe /v1/customers contract", () => {
  it("customer creation response has id, object, email, metadata", async () => {
    const resp = await stripePost("/customers", {
      email: "test@example.com",
      name: "Test Tenant",
      "metadata[tenant_id]": "tenant_test_001",
    });
    expect(resp.status).toBe(200);
    const customer = (await resp.json()) as Record<string, unknown>;
    // id is used throughout billing and subscription routes
    expect(typeof customer.id).toBe("string");
    expect(customer.object).toBe("customer");
    expect(customer.email).toBe("test@example.com");
    // metadata.tenant_id is cross-referenced in billing routes
    expect((customer.metadata as Record<string, string>).tenant_id).toBe("tenant_test_001");
    expect(customer.livemode).toBe(false);
  });
});

describe("Stripe /v1/subscriptions contract", () => {
  it("subscription creation response has id, status, items list", async () => {
    const resp = await stripePost("/subscriptions", {
      customer: "cus_test_placeholder",
      "items[0][price]": "price_test_placeholder",
    });
    expect(resp.status).toBe(200);
    const sub = (await resp.json()) as Record<string, unknown>;
    expect(typeof sub.id).toBe("string");
    expect(sub.object).toBe("subscription");
    expect(sub.status).toBe("active");
    expect(sub.customer).toBe("cus_test_placeholder");
    // items.data is iterated in billing-period-rollover and seat-update inngest fns
    const items = (sub.items as { data: unknown[] }).data;
    expect(items).toHaveLength(1);
  });

  it("subscription cancellation response has status=canceled and canceled_at", async () => {
    const resp = await fetch(
      "https://api.stripe.com/v1/subscriptions/sub_test_placeholder",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer sk_test_placeholder" },
      },
    );
    expect(resp.status).toBe(200);
    const sub = (await resp.json()) as Record<string, unknown>;
    expect(sub.status).toBe("canceled");
    // canceled_at is written to the audit log on subscription cancellation
    expect(typeof sub.canceled_at).toBe("number");
  });
});

describe("Stripe Connect contract", () => {
  it("account creation response has id, type, email", async () => {
    const resp = await stripePost("/accounts", {
      type: "express",
      email: "agent@example.com",
      "metadata[agent_id]": "agent_test_001",
    });
    expect(resp.status).toBe(200);
    const account = (await resp.json()) as Record<string, unknown>;
    expect(typeof account.id).toBe("string");
    expect(account.object).toBe("account");
    expect(account.type).toBe("express");
    // charges_enabled / payouts_enabled are checked in the onboarding-status route
    expect(typeof account.charges_enabled).toBe("boolean");
    expect(typeof account.payouts_enabled).toBe("boolean");
  });

  it("account_link response has url and expires_at", async () => {
    const resp = await stripePost("/account_links", {
      account: "acct_test_placeholder",
      refresh_url: "https://example.com/stripe/refresh",
      return_url: "https://example.com/stripe/return",
      type: "account_onboarding",
    });
    expect(resp.status).toBe(200);
    const link = (await resp.json()) as Record<string, unknown>;
    expect(link.object).toBe("account_link");
    // url is what we redirect the user to for Stripe Connect onboarding
    expect(typeof link.url).toBe("string");
    expect((link.url as string).startsWith("https://")).toBe(true);
    expect(typeof link.expires_at).toBe("number");
  });
});
