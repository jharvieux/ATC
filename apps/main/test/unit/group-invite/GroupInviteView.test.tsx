// @vitest-environment jsdom
//
// specs/design_handoff_group_landing/ RSVP interaction: "clicking one sets
// CurrentUser.rsvpStatus... Updates the stats row's derived counts
// immediately (optimistic update), then persists to the backend."
//
// Covered:
//  - Clicking an RSVP button updates the selected state and the stat counts
//    immediately, before the PATCH resolves
//  - A failed PATCH reverts both the selection and the counts
//  - The anonymous-RSVP checkbox PATCHes visibility_choice

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { GroupInviteView } from "@/components/group-invite/GroupInviteView";
import type { InviteData } from "@/components/group-invite/types";

vi.mock("next/font/google", () => ({
  Quicksand: () => ({ variable: "font-quicksand-mock" }),
}));

function baseData(): InviteData {
  return {
    invitation: { id: "inv-1", rsvp_state: "pending", visibility_choice: "no_opinion" },
    group: {
      id: "grp-1",
      status: "active",
      cruise_line: "Norwegian",
      ship_name: "Bliss",
      sailing_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      departure_port: "Seattle, WA",
      coordinator_message: null,
      hero_image_url: null,
    },
    cabin_grid: { booked: 2, interested: 1, pending: 3, not_going: 0 },
    roster: [],
    itinerary: null,
    ship_stats: null,
    chat_preview: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-cruise-theme");
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GroupInviteView RSVP", () => {
  it("optimistically updates the selection and stat counts before the PATCH resolves, then keeps them on success", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetchPromise));

    render(<GroupInviteView data={baseData()} token="tok-1" />);

    fireEvent.click(screen.getByRole("button", { name: "I've Booked" }));

    // Optimistic: pending count drops, booked count rises, before the fetch resolves.
    expect(screen.getByRole("button", { name: "I've Booked" }).className).toContain("bg-[var(--cruise-accent)]");
    expect(screen.getByText("3")).toBeTruthy(); // new booked count (2 -> 3)
    expect(screen.getByText("2")).toBeTruthy(); // new pending count (3 -> 2)

    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/groups/invite/tok-1",
      expect.objectContaining({ method: "PATCH" }),
    ));

    // Stays booked after the request succeeds.
    expect(screen.getByRole("button", { name: "I've Booked" }).className).toContain("bg-[var(--cruise-accent)]");
  });

  it("reverts the selection and counts when the PATCH fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<GroupInviteView data={baseData()} token="tok-1" />);

    fireEvent.click(screen.getByRole("button", { name: "I've Booked" }));

    await waitFor(() => {
      // Reverted: booked button no longer selected, original pending count (3) is back.
      expect(screen.getByRole("button", { name: "I've Booked" }).className).not.toContain("bg-[var(--cruise-accent)]");
    });
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("reverting a second failed change doesn't wipe out an earlier successful one — regression for reverting to a stale mount-time snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }) // first click succeeds
      .mockResolvedValueOnce({ ok: false }); // second click fails
    vi.stubGlobal("fetch", fetchMock);

    render(<GroupInviteView data={baseData()} token="tok-1" />);

    // First: pending(3) -> interested. Succeeds and stays (interested 1->2, pending 3->2).
    fireEvent.click(screen.getByRole("button", { name: "I'm Interested" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Second: interested -> booked. Fails and must revert to the post-first-change
    // state (interested=2, pending=2), not the original mount-time snapshot
    // (interested=1, pending=3).
    fireEvent.click(screen.getByRole("button", { name: "I've Booked" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "I've Booked" }).className).not.toContain("bg-[var(--cruise-accent)]");
    });
    expect(screen.getByRole("button", { name: "I'm Interested" }).className).toContain("bg-[var(--cruise-accent)]");
    // Booked count is back to its original 2 (never should have shown 3).
    // Interested count stays at its post-first-change value of 2, not reverted to 1.
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(2);
  });

  it("PATCHes visibility_choice when the anonymous checkbox is toggled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<GroupInviteView data={baseData()} token="tok-1" />);

    fireEvent.click(screen.getByLabelText("RSVP anonymously"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/invite/tok-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ visibility_choice: "be_anonymous" }),
      }),
    ));
  });
});
