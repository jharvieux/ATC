// @vitest-environment jsdom
//
// #1813 audit follow-up — pre-pr-reviewer flagged that the passenger-rows
// stable-key fix (page.tsx Stage2PassengerDetails, key={p._key} at ~line 417)
// shipped with zero test coverage: a regression back to key={idx} would pass
// CI silently. Two behaviors pinned here:
//
// 1. Mid-list-removal DOM identity — "Remove passenger" filters the array by
//    index, so every row after the removed one shifts down a position. With
//    key={idx}, React's keyed diff treats identity as *position*: the fiber
//    (and its underlying DOM node) for the highest index gets torn down
//    whenever the array shrinks, and the surviving rows are patched in place
//    on whichever nodes already sat at their new positions — even though the
//    on-screen *value* is always correct (it's a controlled input driven by
//    state), the physical DOM node backing a given passenger's row does not
//    survive the removal. With the stable `_key` (crypto.randomUUID(), tied
//    to the passenger record, not its position), that same node survives and
//    is simply re-indexed. We assert survival by capturing the actual DOM
//    node reference before the removal and checking it's still attached
//    afterward — a value-only check (re-querying by id) can't tell the two
//    strategies apart, since the value is correct either way.
// 2. Client-only key never reaches the server — `_key` is stripped from the
//    POST body (page.tsx ~line 389) before it's sent to
//    /api/bookings/[id]/passengers.

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const BookingFlowPage = (await import("@/app/booking/flow/[id]/[stage]/page")).default;

const BOOKING_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function mockFetchSequence(...handlers: Array<(url: string, init?: RequestInit) => unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

async function renderStage2(): Promise<void> {
  render(<BookingFlowPage params={Promise.resolve({ id: BOOKING_ID, stage: "2" })} />);
  // The stage-progress nav also has a "Passenger Details" label, so wait on
  // the section heading (an actual <h2>) to be sure the passengers fetch has
  // resolved and loading has flipped false — not just that the page mounted.
  await screen.findByRole("heading", { name: "Passenger Details" });
}

beforeEach(() => {
  // NoAnonGuard (§20.8) reads this cookie to decide whether to redirect to
  // /signup; both tests exercise an authenticated flow.
  document.cookie = "sb-access-token=test-session";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Stage2PassengerDetails — stable row keys (#1813)", () => {
  it("keeps the same DOM node (and its typed value) attached after removing an earlier row", async () => {
    mockFetchSequence(() => jsonResponse(200, { passengers: [] }));
    await renderStage2();

    const addButton = screen.getByRole("button", { name: /add another passenger/i });
    fireEvent.click(addButton); // now 2 rows: idx0 (lead, no remove control), idx1
    fireEvent.click(addButton); // now 3 rows: idx0, idx1, idx2

    // idx0 is the lead passenger and has no "Remove passenger" control, so
    // the removable rows are idx1 and idx2. Track idx2's input, remove idx1
    // (the mid-list removal), and confirm idx2's actual DOM node survives.
    const trackedInput = document.getElementById("p2_first") as HTMLInputElement | null;
    expect(trackedInput).not.toBeNull();
    fireEvent.change(trackedInput!, { target: { value: "ZKQ-DISTINCT-99" } });

    const removeButtons = screen.getAllByRole("button", { name: "Remove passenger" });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[0]!); // removes idx1

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Remove passenger" })).toHaveLength(1);
    });

    // The captured node is the same object reference from before the
    // removal — with index keys it would have been unmounted and a value
    // check alone would not catch that.
    expect(document.body.contains(trackedInput)).toBe(true);
    expect(trackedInput!.value).toBe("ZKQ-DISTINCT-99");
    // Re-indexed in place: was idx2 ("p2_first"), is now idx1 ("p1_first").
    expect(trackedInput!.id).toBe("p1_first");
  });

  it("strips the client-only _key from the passengers POST payload", async () => {
    let capturedBody: string | undefined;
    mockFetchSequence(
      () => jsonResponse(200, { passengers: [] }),
      (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse(200, { ok: true });
      },
    );
    await renderStage2();

    fireEvent.change(document.getElementById("p0_first")!, { target: { value: "Jamie" } });
    fireEvent.change(document.getElementById("p0_last")!, { target: { value: "Rivera" } });
    fireEvent.change(document.getElementById("p0_dob")!, { target: { value: "1990-01-01" } });

    fireEvent.click(screen.getByRole("button", { name: /save & continue/i }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    const body = JSON.parse(capturedBody!) as { passengers: Array<Record<string, unknown>> };
    expect(body.passengers).toHaveLength(1);
    expect(body.passengers[0]).not.toHaveProperty("_key");
  });
});
