// @vitest-environment jsdom
//
// §20.7 (#1876) — the booking confirmation page must carry the tenant-of-record
// legal disclosure (the component's own header comment lists it as one of the
// four required surfaces). This pins:
//
// 1. The disclosure renders the REAL sub-host + host-agency legal name from
//    /api/bookings/[id]/tenant-of-record (the #1878 route) — never a placeholder.
// 2. Fail-closed: a fetch failure or a null legal/tenant name renders NO
//    disclosure at all (never a fabricated legal name), and the rest of the
//    confirmation page still renders.

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const BookingConfirmationPage = (await import("@/app/booking/confirmation/[id]/page")).default;

const BOOKING_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const BOOKING = {
  id: BOOKING_ID,
  status: "submitted",
  cruise_line: "Norwegian",
  ship_name: "Bliss",
  sailing_date: "2026-09-15",
  duration_nights: 7,
  cabin_category: "Balcony",
  total_amount: "1200.00",
  currency: "USD",
  host_adapter: "mock",
  host_booking_reference: "PBR-1",
};

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function renderPage(handler: (url: string) => unknown): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(handler(url))) as unknown as typeof fetch,
  );
  render(<BookingConfirmationPage params={Promise.resolve({ id: BOOKING_ID })} />);
  await screen.findByText("Your booking is confirmed!");
}

beforeEach(() => {
  document.cookie = "sb-access-token=test-session";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingConfirmationPage — tenant-of-record disclosure (#1876)", () => {
  it("renders the real tenant + host-agency data, not placeholder strings", async () => {
    await renderPage((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(200, {
          tenant: { name: "Coral Cove Travel", support_email: "help@coralcove.example" },
          host_agency: { legal_name: "Wavecrest Host Agency LLC" },
        });
      }
      return jsonResponse(200, { booking: BOOKING });
    });

    await waitFor(() => {
      expect(screen.queryByText("Wavecrest Host Agency LLC")).not.toBeNull();
    });
    expect(screen.getByText("Coral Cove Travel")).toBeDefined();
    expect(screen.getByText("help@coralcove.example")).toBeDefined();
    expect(screen.queryByText("Host Agency")).toBeNull();
    expect(screen.queryByText("Sub-host")).toBeNull();
  });

  it("fails closed — renders NO disclosure (no placeholder) when the route returns a null legal name", async () => {
    await renderPage((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(200, {
          tenant: { name: "Coral Cove Travel", support_email: "help@coralcove.example" },
          host_agency: { legal_name: null },
        });
      }
      return jsonResponse(200, { booking: BOOKING });
    });

    // No disclosure block, no fabricated placeholder — but the booking summary is intact.
    await waitFor(() => {
      expect(screen.queryByText(/This booking will be made through/i)).toBeNull();
    });
    expect(screen.queryByText("Host Agency")).toBeNull();
    expect(screen.getByText("Trip details")).toBeDefined();
  });

  it("fails closed — renders NO disclosure when the tenant-of-record fetch fails", async () => {
    await renderPage((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(500, { error: "internal" });
      }
      return jsonResponse(200, { booking: BOOKING });
    });

    await waitFor(() => {
      expect(screen.getByText("Trip details")).toBeDefined();
    });
    expect(screen.queryByText(/This booking will be made through/i)).toBeNull();
    expect(screen.queryByText("Host Agency")).toBeNull();
  });
});
