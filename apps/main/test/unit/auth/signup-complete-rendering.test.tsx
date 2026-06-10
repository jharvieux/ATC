// @vitest-environment jsdom
// Component rendering tests that need DOM interaction use @vitest-environment jsdom.
// Logic-only tests (pure functions) stay in the node environment (default).
//
// §17.3 — /signup/complete rendering contracts.
//
// Test 1: sub_host option is not rendered (#961). The option was hidden to avoid
// exposing an incomplete feature. This test guards against accidental re-exposure.
//
// Test 2: submitting an empty form shows per-field validation errors. The page
// uses `noValidate` so native browser validation is off — the inline errors are
// the only guard before a server round-trip.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SignupCompletePage from "@/app/signup/complete/page";

// Prevent fetch calls from useEffect (slug availability check).
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ available: true }), ok: true }));

afterEach(() => { cleanup(); });

beforeEach(() => {
  // Radix UI Select requires ResizeObserver and matchMedia to mount without errors.
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("/signup/complete rendering", () => {
  it("does not render the sub_host radio option (#961)", () => {
    render(<SignupCompletePage />);
    // sub_host was hidden to defer the feature (#961). If this test fails, the
    // option was re-exposed — confirm the feature is ready before removing the guard.
    const subHostRadio = document.querySelector('input[type="radio"][value="sub_host"]');
    expect(subHostRadio).toBeNull();
  });

  it("shows per-field errors for every required field when submitted empty", () => {
    render(<SignupCompletePage />);
    const submitButton = screen.getByRole("button", { name: /create workspace/i });
    fireEvent.click(submitButton);

    // Per-field error messages must appear so the user knows what to fix
    // without a server round-trip (noValidate disables native browser validation).
    expect(screen.getByText("Agency display name is required.")).toBeTruthy();

    // The display_name field must be marked invalid so assistive technology
    // and CSS red-border styles activate correctly.
    const displayNameInput = document.getElementById("display_name");
    expect(displayNameInput?.getAttribute("aria-invalid")).toBe("true");
  });
});
