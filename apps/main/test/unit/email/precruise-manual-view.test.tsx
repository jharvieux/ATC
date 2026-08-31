// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreCruiseEmailsView } from "@/app/(tenant)/crm/pre-cruise-emails/_components/PreCruiseEmailsView";

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING = {
  id: BOOKING_ID,
  status: "confirmed",
  cruise_line: "Royal Caribbean",
  ship_name: "Icon of the Seas",
  sailing_date: "2027-05-01",
  primary_contact: {
    id: "contact-1",
    first_name: "Avery",
    last_name: "Quinn",
    email: "avery@example.com",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetch(options: { failBookingRefresh?: boolean } = {}) {
  let bookingLoads = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return jsonResponse({ ok: true }, 202);
    bookingLoads += 1;
    if (options.failBookingRefresh && bookingLoads > 1) throw new Error("network down");
    return jsonResponse({ bookings: [BOOKING], total: 1, page: 1, page_size: 100 });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PreCruiseEmailsView", () => {
  it("loads a booking and schedules the selected phase using local-time conversion", async () => {
    const fetchMock = installFetch();
    render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    expect(screen.getByText("T−90 days")).toBeDefined();
    expect(screen.getByText("T−30 days")).toBeDefined();
    expect(screen.getByText("T−7 days")).toBeDefined();
    expect(screen.getByText("T−1 day")).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: /T−7 days/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Schedule" }));
    const localSchedule = "2027-01-20T09:30";
    fireEvent.change(screen.getByLabelText(/Delivery date and time/), {
      target: { value: localSchedule },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule email" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      action: "schedule",
      booking_id: BOOKING_ID,
      phase: "t_7",
      scheduled_for: new Date(localSchedule).toISOString(),
    });
    expect((await screen.findByRole("status")).textContent).toContain("7 days email is scheduled");
  });

  it("clears the selected traveler when a booking refresh fails", async () => {
    installFetch({ failBookingRefresh: true });
    render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    expect((screen.getByRole("button", { name: "Send email now" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Search traveler"), { target: { value: "missing" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load confirmed bookings");

    expect(screen.queryByRole("option", { name: /Avery Quinn/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Send email now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
