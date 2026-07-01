// @vitest-environment jsdom
//
// §19.x — ForumTabClient's ONLY change for the anonymous-invitee forum PR:
// resolving a message's displayed author label when it's guest-authored
// (invitation_id set) vs. user-authored (user_id set). Everything else in
// this component (styling/layout) is out of scope — a concurrent PR
// (feature/coordinator-relayout) reskins it visually.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
global.fetch = mocks.fetch as unknown as typeof fetch;

import { ForumTabClient } from "@/components/groups/ForumTabClient";

const THREAD = { id: "th-1", title: "Excursions", is_locked: false, is_pinned: false, is_announcement: false, created_at: "2026-06-01T00:00:00Z" };

function mockForumLoad() {
  mocks.fetch.mockImplementation((url: string) => {
    if (url.includes("/forum") && !url.includes("/threads")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ forum_id: "forum-1", is_locked: false, is_coordinator: true }) });
    }
    if (url.endsWith("/threads")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ threads: [THREAD] }) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  cleanup();
  mocks.fetch.mockReset();
});

describe("ForumTabClient — guest vs. user author-name resolution", () => {
  it("shows the server-computed author_name for a guest (invitation_id) message", async () => {
    mockForumLoad();
    render(<ForumTabClient groupId="group-1" />);

    const openButton = await screen.findByText("Excursions");

    mocks.fetch.mockImplementation((url: string) => {
      if (url.includes("/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            messages: [
              { id: "m-1", content: "Can't wait!", status: "visible", user_id: null, invitation_id: "inv-1", author_name: "Jenna R.", parent_message_id: null, created_at: "2026-06-02T00:00:00Z" },
            ],
          }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    fireEvent.click(openButton);

    expect(await screen.findByText("Jenna R.")).toBeTruthy();
  });

  it("falls back to the truncated user_id for a user-authored message (unchanged behavior)", async () => {
    mockForumLoad();
    render(<ForumTabClient groupId="group-1" />);

    const openButton = await screen.findByText("Excursions");

    mocks.fetch.mockImplementation((url: string) => {
      if (url.includes("/messages")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            messages: [
              { id: "m-2", content: "Me too!", status: "visible", user_id: "11111111-2222-3333-4444-555555555555", invitation_id: null, author_name: null, parent_message_id: null, created_at: "2026-06-02T00:00:00Z" },
            ],
          }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    fireEvent.click(openButton);

    expect(await screen.findByText("11111111…")).toBeTruthy();
  });
});
