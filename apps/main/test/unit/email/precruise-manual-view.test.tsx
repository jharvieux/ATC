// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const stateSetterTracker = vi.hoisted(() => ({ enabled: false, calls: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initialState: T | (() => T)) => {
      const [value, setValue] = actual.useState(initialState);
      const trackedSetValue: typeof setValue = (next) => {
        if (stateSetterTracker.enabled) stateSetterTracker.calls += 1;
        setValue(next);
      };
      return [value, trackedSetValue] as const;
    },
  };
});

import { PreCruiseEmailsView } from "@/app/(tenant)/crm/pre-cruise-emails/_components/PreCruiseEmailsView";

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING = {
  id: BOOKING_ID,
  status: "confirmed",
  cruise_line: "Royal Caribbean",
  ship_name: "Icon of the Seas",
  sailing_date: "2027-05-01",
  primary_contact: {
    id: "33333333-3333-4333-8333-333333333333",
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

function installFetch(options: {
  failBookingRefresh?: boolean;
  dispatchResponse?: Promise<Response>;
  bookingResponses?: Array<Response | Promise<Response>>;
} = {}) {
  let bookingLoads = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return options.dispatchResponse ?? jsonResponse({ ok: true }, 202);
    bookingLoads += 1;
    const configuredResponse = options.bookingResponses?.[bookingLoads - 1];
    if (configuredResponse) return configuredResponse;
    if (options.failBookingRefresh && bookingLoads > 1) throw new Error("network down");
    return jsonResponse({ bookings: [BOOKING], total: 1, page: 1, page_size: 100 });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  stateSetterTracker.enabled = false;
  stateSetterTracker.calls = 0;
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
      expected_contact_id: BOOKING.primary_contact.id,
      expected_contact_email: BOOKING.primary_contact.email,
      scheduled_for: new Date(localSchedule).toISOString(),
    });
    expect((await screen.findByRole("status")).textContent).toContain("7 days email is scheduled");
  });

  it("invalidates the selected traveler before a failing refresh can dispatch", async () => {
    const fetchMock = installFetch({ failBookingRefresh: true });
    render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    expect((screen.getByRole("button", { name: "Send email now" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Search traveler"), { target: { value: "missing" } });
    const sendButton = screen.getByRole("button", { name: "Send email now" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load confirmed bookings");

    expect(screen.queryByRole("option", { name: /Avery Quinn/ })).toBeNull();
    expect(sendButton.disabled).toBe(true);
  });

  it("locks mutable form state while a dispatch is pending", async () => {
    let resolveDispatch!: (response: Response) => void;
    const dispatchResponse = new Promise<Response>((resolve) => {
      resolveDispatch = resolve;
    });
    installFetch({ dispatchResponse });
    render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    fireEvent.click(screen.getByRole("button", { name: "Send email now" }));

    expect((screen.getByLabelText("Search traveler") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /T−1 day/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Schedule" }) as HTMLInputElement).disabled).toBe(true);

    resolveDispatch(jsonResponse({ ok: true }, 202));
    expect((await screen.findByRole("status")).textContent).toContain("90 days email is queued to send now");
  });

  it("tells the agent to review the booking when the recipient changed", async () => {
    installFetch({
      dispatchResponse: Promise.resolve(jsonResponse({ error: "recipient_changed" }, 409)),
    });
    render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    fireEvent.click(screen.getByRole("button", { name: "Send email now" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The booking's primary contact changed. Review the booking and try again.",
    );
  });

  it("lets an accepted dispatch finish after unmount without updating local state", async () => {
    let resolveDispatch!: (response: Response) => void;
    const dispatchResponse = new Promise<Response>((resolve) => {
      resolveDispatch = resolve;
    });
    const fetchMock = installFetch({ dispatchResponse });
    const { unmount } = render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    fireEvent.click(screen.getByRole("button", { name: "Send email now" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });

    unmount();
    stateSetterTracker.calls = 0;
    stateSetterTracker.enabled = true;
    await act(async () => {
      resolveDispatch(jsonResponse({ ok: true }, 202));
      await dispatchResponse;
    });

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[1]?.signal).toBeUndefined();
    expect(stateSetterTracker.calls).toBe(0);
  });

  it("ignores an older search response after a newer query invalidates it", async () => {
    let resolveStaleSearch!: (response: Response) => void;
    const staleSearch = new Promise<Response>((resolve) => {
      resolveStaleSearch = resolve;
    });
    let resolveCurrentSearch!: (response: Response) => void;
    const currentSearch = new Promise<Response>((resolve) => {
      resolveCurrentSearch = resolve;
    });
    const fetchMock = installFetch({
      bookingResponses: [
        jsonResponse({ bookings: [BOOKING] }),
        staleSearch,
        currentSearch,
      ],
    });
    const { container } = render(<PreCruiseEmailsView />);

    await screen.findByRole("option", { name: /Avery Quinn/ });
    fireEvent.change(screen.getByLabelText("Search traveler"), { target: { value: "av" } });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
    });

    container.addEventListener("change", () => {
      resolveStaleSearch(jsonResponse({ bookings: [BOOKING] }));
    }, { once: true });
    fireEvent.change(screen.getByLabelText("Search traveler"), { target: { value: "avery" } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(3);
    });
    expect(screen.queryByRole("option", { name: /Avery Quinn/ })).toBeNull();
    const sendButton = screen.getByRole("button", { name: "Send email now" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    resolveCurrentSearch(jsonResponse({ bookings: [] }));
    await screen.findByRole("option", { name: "No eligible bookings found" });
  });
});
