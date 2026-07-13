// @vitest-environment jsdom
//
// #1810 — operator-console UI for resolving pending_host_review bookings.
// Pins two behaviors that would silently break the double-book guard's UX if
// regressed: (1) the 409 host_booking_may_exist refusal must be shown to the
// operator with its "do not re-submit, investigate" meaning, not swallowed as
// a generic error; (2) a 200 success must refresh the status badge in place
// (draft) rather than leaving the stale pending_host_review state on screen.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// The installed "react" (18.3.1) has no `use()` export — Next.js aliases
// "react" to its own bundled canary build at build time, which is why
// `use(params)` works in the real app but not under plain Vitest module
// resolution. Patch a minimal `use()` in for this test only; the page under
// test is given a synchronous (non-native) thenable below so this resolves
// on the first render without needing real Suspense support.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: (thenable: PromiseLike<unknown>) => {
      let result: { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown } | undefined;
      thenable.then(
        (value) => {
          result = { status: "fulfilled", value };
        },
        (reason) => {
          result = { status: "rejected", reason };
        },
      );
      if (!result) throw new Error("test thenable did not resolve synchronously");
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
  };
});

function syncThenable<T>(value: T): Promise<T> {
  return {
    then: (onFulfilled?: (v: T) => unknown) => onFulfilled?.(value) as never,
  } as unknown as Promise<T>;
}

vi.mock("@/components/deliverables/ItineraryEditor", () => ({
  ItineraryEditor: () => null,
}));
vi.mock("@/components/deliverables/ResourcesEditor", () => ({
  ResourcesEditor: () => null,
}));
vi.mock("@/components/line-items/LineItemsPanel", () => ({
  LineItemsPanel: () => null,
}));

const BookingDetailPage = (await import("@/app/(tenant)/crm/bookings/[id]/page")).default;

const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function booking(status: string) {
  return {
    id: BOOKING_ID,
    status,
    cruise_line: "Royal Seas",
    ship_name: "Wanderer",
    sailing_date: "2027-01-01",
    duration_nights: 7,
    cabin_category: "Balcony",
    departure_port: "Miami",
    total_amount: "1000.00",
    currency: "USD",
    host_adapter: null,
    host_booking_reference: null,
    is_test: false,
  };
}

function mockFetchSequence(...handlers: Array<(url: string, init?: RequestInit) => unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    const body = handler(url, init);
    return Promise.resolve(body);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingDetailPage — resolve pending_host_review (#1810)", () => {
  it("shows the refusal message and keeps status unchanged on a 409 host_booking_may_exist", async () => {
    mockFetchSequence(
      () => jsonResponse(200, { booking: booking("pending_host_review"), primary_contact: null }),
      () =>
        jsonResponse(409, {
          error: "host_booking_may_exist",
          review_reason: "commission_write_failed",
          message:
            "This booking may have a live host reservation and cannot be returned to draft. Manual reconciliation is required.",
        }),
    );

    render(<BookingDetailPage params={syncThenable({ id: BOOKING_ID })} />);

    const button = await screen.findByRole("button", { name: "Resolve for editing" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Manual reconciliation is required/)).toBeTruthy();
    });
    expect(screen.getByText(/do not re-submit it/i)).toBeTruthy();
    expect(screen.getByText("pending host review")).toBeTruthy();
  });

  it("refreshes the status badge to draft on a 200 success", async () => {
    mockFetchSequence(
      () => jsonResponse(200, { booking: booking("pending_host_review"), primary_contact: null }),
      () => jsonResponse(200, { ok: true, status: "draft" }),
    );

    render(<BookingDetailPage params={syncThenable({ id: BOOKING_ID })} />);

    const button = await screen.findByRole("button", { name: "Resolve for editing" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("draft")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Resolve for editing" })).toBeNull();
  });
});
