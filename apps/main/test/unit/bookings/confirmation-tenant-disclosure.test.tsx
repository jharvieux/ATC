// @vitest-environment jsdom
//
// §20.7 (#1876) — the booking confirmation page must carry the tenant-of-record
// legal disclosure (the component's own header comment lists it as one of the
// four required surfaces). This pins:
//
// 1. The disclosure renders the REAL sub-host + host-agency legal name from
//    /api/bookings/[id]/tenant-of-record (the #1878 route) — never a placeholder.
// 2. Fail-closed on the legal names: a fetch failure or a null legal/tenant name
//    never renders a fabricated disclosure. But because this is a required §20.7
//    legal surface, the failure is surfaced as a visible load-failure notice
//    (matching the sibling Review-stage flow page) rather than silently omitted,
//    and the rest of the confirmation page still renders.

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
    // Happy path shows no load-failure notice.
    expect(screen.queryByText(/Couldn't load the tenant-of-record disclosure/i)).toBeNull();
  });

  it("null legal name — no fabricated disclosure, but a visible load-failure notice (never silently omitted)", async () => {
    await renderPage((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(200, {
          tenant: { name: "Coral Cove Travel", support_email: "help@coralcove.example" },
          host_agency: { legal_name: null },
        });
      }
      return jsonResponse(200, { booking: BOOKING });
    });

    // The load-failure notice appears in place of the disclosure — but no
    // fabricated legal name, and the booking summary is intact.
    await waitFor(() => {
      expect(screen.queryByText(/Couldn't load the tenant-of-record disclosure/i)).not.toBeNull();
    });
    expect(screen.queryByText(/This booking will be made through/i)).toBeNull();
    expect(screen.queryByText("Host Agency")).toBeNull();
    expect(screen.getByText("Trip details")).toBeDefined();
  });

  it("fetch failure — no disclosure, but a visible load-failure notice (never silently omitted)", async () => {
    await renderPage((url) => {
      if (url.includes("/tenant-of-record")) {
        return jsonResponse(500, { error: "internal" });
      }
      return jsonResponse(200, { booking: BOOKING });
    });

    await waitFor(() => {
      expect(screen.queryByText(/Couldn't load the tenant-of-record disclosure/i)).not.toBeNull();
    });
    expect(screen.getByText("Trip details")).toBeDefined();
    expect(screen.queryByText(/This booking will be made through/i)).toBeNull();
    expect(screen.queryByText("Host Agency")).toBeNull();
  });
});
