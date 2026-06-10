// §17.3 — /signup/complete page unit tests.
//
// The page's pure-logic exports are tested here:
// - buildWorkspaceUrl encodes the routing contract: after provisioning, the
//   operator is sent to a SUBDOMAIN of the current platform hostname at
//   /onboarding/legal, not to the platform domain itself.
// - validateSignupForm (#961) mirrors the required-field checks in
//   /api/auth/signup/complete so an invalid submit is rejected client-side
//   with per-field messages instead of a silent no-op or a server round-trip.
//
// Interactive paths (201 → success screen, 401 → router.push, hidden
// sub_host option, red-border rendering) require a browser-like environment
// (jsdom + RTL). They are not yet covered at any layer — E2E stubs in
// tests/e2e/onboarding.spec.ts are all test.fixme() with no body. Unit
// coverage deferred until @testing-library/react + jsdom are added to the
// test stack.

import { describe, it, expect } from "vitest";
import { buildWorkspaceUrl, validateSignupForm } from "@/app/signup/complete/page";

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

describe("validateSignupForm", () => {
  const valid = {
    display_name: "Acme Travel",
    legal_name: "Acme Travel LLC",
    support_email: "support@acmetravel.com",
    line1: "123 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701",
  };

  it("accepts a fully-filled form", () => {
    expect(validateSignupForm(valid)).toEqual({});
  });

  it("flags every server-required field when the form is empty", () => {
    const errors = validateSignupForm({
      display_name: "", legal_name: "", support_email: "",
      line1: "", city: "", state: "", zip: "",
    });
    // Same field set the server 400s on (display_name_required, legal_name_required,
    // support_email_required, mailing_address_required) — a miss here means the
    // user only learns about the gap after a server round-trip.
    expect(Object.keys(errors).sort()).toEqual(
      ["city", "display_name", "legal_name", "line1", "state", "support_email", "zip"].sort(),
    );
    for (const msg of Object.values(errors)) expect(msg).toBeTruthy();
  });

  it("orders keys top-of-page first so the first invalid field gets focus", () => {
    const errors = validateSignupForm({ ...valid, display_name: "", zip: "" });
    // handleSubmit focuses Object.keys(errors)[0] — insertion order is the contract.
    expect(Object.keys(errors)[0]).toBe("display_name");
  });

  it("rejects whitespace-only values, matching the server's .trim() checks", () => {
    const errors = validateSignupForm({ ...valid, legal_name: "   ", city: "\t" });
    expect(errors.legal_name).toBeTruthy();
    expect(errors.city).toBeTruthy();
  });

  it("rejects a malformed support email (form uses noValidate, so native type=email checks are off)", () => {
    const errors = validateSignupForm({ ...valid, support_email: "not-an-email" });
    expect(errors.support_email).toBe("Enter a valid email address.");
  });
});
