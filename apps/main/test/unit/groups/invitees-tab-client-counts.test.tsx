// @vitest-environment jsdom
//
// #1812 audit blocker — the useState-clustering refactor merged the
// invitations+counts fetch into one setList call, but seeded `counts` from
// a local `{}` when the parallel group-details fetch (grpRes) failed. On
// dev, a failed grpRes preserved the previous counts (the setCounts call
// was conditional). This pins that a transient grpRes failure on a
// subsequent load must carry forward the prior counts, not zero them.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
global.fetch = mocks.fetch as unknown as typeof fetch;

import { InviteesTabClient } from "@/components/groups/InviteesTabClient";

function mockLoad(grpOk: boolean) {
  mocks.fetch.mockImplementation((url: string) => {
    if (url.endsWith("/invitations")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ invitations: [] }) });
    }
    if (grpOk) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ invitation_counts: { booked: 2 } }) });
    }
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  cleanup();
  mocks.fetch.mockReset();
});

describe("InviteesTabClient — counts survive a failed grpRes", () => {
  it("keeps the prior RSVP count chip when a refresh's group-details fetch fails", async () => {
    mockLoad(true);
    render(<InviteesTabClient groupId="group-1" />);

    expect(await screen.findByText("2 Booked")).toBeTruthy();

    mockLoad(false);
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(await screen.findByText("2 Booked")).toBeTruthy();
  });
});
