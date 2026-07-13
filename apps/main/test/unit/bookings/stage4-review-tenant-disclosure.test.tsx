// @vitest-environment jsdom
//
// #1856 — Stage4Review previously hardcoded "Your Agency" /
// "support@youragency.com" / "Host Agency" into the §20.7 tenant-of-record
// disclosure instead of reading the booking's real sub-host tenant and
// platform host-agency legal name. This pins two things so the fix can't
// silently regress:
//
// 1. The disclosure renders the REAL values from
//    /api/bookings/[id]/tenant-of-record, and the placeholder strings never
//    appear anywhere on the page.
// 2. Fail-closed: if that fetch fails, the page must NOT fall back to
//    placeholder text — it shows an error and disables the submit button
//    rather than let a customer confirm a booking under a fabricated legal
//    disclosure.

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const BookingFlowPage = (await import("@/app/booking/flow/[id]/[stage]/page")).default;

const BOOKING_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function renderStage4(
  handler: (url: string) => unknown,
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(handler(url))) as unknown as typeof fetch,
  );
  render(<BookingFlowPage params={Promise.resolve({ id: BOOKING_ID, stage: "4" })} />);
  await screen.findByRole("heading", { name: "Review & Submit" });
}

beforeEach(() => {
  // NoAnonGuard (§20.8) reads this cookie to decide whether to redirect to /signup.
  document.cookie = "sb-access-token=test-session";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Stage4Review — tenant-of-record disclosure (#1856)", () => {
  it("renders the real tenant + host-agency data, not the placeholder strings", async () => {
    await renderStage4((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(200, {
          tenant: { name: "Coral Cove Travel", support_email: "help@coralcove.example" },
          host_agency: { legal_name: "Wavecrest Host Agency LLC" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await waitFor(() => {
      expect(screen.queryByText("Coral Cove Travel")).not.toBeNull();
    });
    expect(screen.getByText("Wavecrest Host Agency LLC")).toBeDefined();
    expect(screen.getByText("help@coralcove.example")).toBeDefined();

    // The regression this test guards against.
    expect(screen.queryByText("Your Agency")).toBeNull();
    expect(screen.queryByText("Host Agency")).toBeNull();
    expect(screen.queryByText("support@youragency.com")).toBeNull();

    // The disclosure loaded, so submission is allowed.
    const submitButton = screen.getByRole("button", { name: /confirm & submit booking/i }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
  });

  it("fails closed — shows an error and disables submit, never a placeholder, if the fetch fails", async () => {
    await renderStage4((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(500, { error: "internal" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await waitFor(() => {
      expect(screen.queryByText(/couldn't load the tenant-of-record disclosure/i)).not.toBeNull();
    });

    expect(screen.queryByText("Your Agency")).toBeNull();
    expect(screen.queryByText("Host Agency")).toBeNull();
    const submitButton = screen.getByRole("button", { name: /confirm & submit booking/i }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});
