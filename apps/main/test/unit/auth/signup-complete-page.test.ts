// §17.3 — /signup/complete page unit tests.
//
// buildWorkspaceUrl is the only pure-logic export from the page. It encodes
// the routing contract: after provisioning, the operator is sent to a
// SUBDOMAIN of the current platform hostname at /onboarding/legal, not
// to the platform domain itself.
//
// Interactive paths (201 → success screen, 401 → router.push) require a
// browser-like environment (jsdom + RTL). They are not yet covered at any
// layer — E2E stubs in tests/e2e/onboarding.spec.ts are all test.fixme()
// with no body. Unit coverage deferred until @testing-library/react +
// jsdom are added to the test stack.

import { describe, it, expect } from "vitest";
import { buildWorkspaceUrl } from "@/app/signup/complete/page";

describe("buildWorkspaceUrl", () => {
  it("returns the tenant subdomain at /onboarding/legal", () => {
    const url = buildWorkspaceUrl("acme-travel", {
      protocol: "https:",
      hostname: "ai-travelconcierge.com",
    });
    expect(url).toBe(
      "https://acme-travel.ai-travelconcierge.com/onboarding/legal",
    );
  });

  it("uses the current protocol (http for local dev)", () => {
    const url = buildWorkspaceUrl("my-agency", {
      protocol: "http:",
      hostname: "localhost",
    });
    expect(url).toBe("http://my-agency.localhost/onboarding/legal");
  });

  it("preserves slug exactly — no case normalisation applied here", () => {
    const url = buildWorkspaceUrl("beta-agency-2", {
      protocol: "https:",
      hostname: "example.com",
    });
    expect(new URL(url).hostname).toBe("beta-agency-2.example.com");
    expect(new URL(url).pathname).toBe("/onboarding/legal");
  });
});
