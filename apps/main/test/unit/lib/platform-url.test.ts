// Tests for tenantOriginFromRequest() (§15.6/§15.8/§15.9 Stripe redirect origin).
//
// WHY: the onboarding Stripe redirect routes must send the user back to the
// tenant's own host (subdomain or custom domain), NOT a platform-level origin.
// Onboarding APIs resolve tenant_id from the request Host; the platform domain
// resolves to the "platform" sentinel and every onboarding call throws
// ("Failed to load page"). A regression that builds the redirect from a fixed
// platform origin must fail a test, not ship silently.

import { describe, it, expect } from "vitest";
import { tenantOriginFromRequest } from "@/lib/platform-url";

describe("tenantOriginFromRequest", () => {
  it("returns the origin (scheme + host) of the request — a tenant subdomain", () => {
    const req = new Request("https://lisa-travel.ai-travelconcierge.com/api/onboarding/subscription/checkout");
    expect(tenantOriginFromRequest(req)).toBe("https://lisa-travel.ai-travelconcierge.com");
  });

  it("preserves a custom-domain host", () => {
    const req = new Request("https://book.lisatravel.com/api/onboarding/connect/link");
    expect(tenantOriginFromRequest(req)).toBe("https://book.lisatravel.com");
  });

  it("strips path and query but keeps scheme/host/port (local dev over http)", () => {
    const req = new Request("http://localhost:3000/api/onboarding/tax-form/stripe-link?foo=bar");
    expect(tenantOriginFromRequest(req)).toBe("http://localhost:3000");
  });
});
