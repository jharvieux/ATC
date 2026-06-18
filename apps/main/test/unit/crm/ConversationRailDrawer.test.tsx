// @vitest-environment jsdom
//
// WHY: ConversationRailDrawer shipped in #1232 without assertions for two
// regression-prone behaviors:
//
//  1. Retry mechanic — when fetch fails (non-ok or throws), hasFetched.current
//     is reset so the next drawer open re-fetches instead of staying stuck on a
//     stale error. Without this guard, a transient 503 would permanently break
//     the drawer for the session.
//
//  2. isStaff render gate — layout.tsx conditionally mounts the drawer only for
//     tenant_owner / agent roles. Tests for that gate live in the sibling file
//     tenant-area-layout-isstaff.test.tsx.
//
// Covered here:
//  - Initial state: drawer is closed, no fetch on mount
//  - Toggle: open/close via the PanelLeft button
//  - Fetch on first open
//  - Success path: conversations rendered, no retry
//  - HTTP-error path: error message shown, hasFetched reset (retry on re-open)
//  - Network-throw path: error message shown, hasFetched reset (retry on re-open)
//  - No duplicate fetch after success (hasFetched.current guard)
//  - Close button, Escape key, backdrop click all close the drawer

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

// --- module stubs ---

vi.mock("next/link", () => ({
  default: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, className }: { children: React.ReactNode; asChild?: boolean; className?: string }) =>
    asChild ? <>{children}</> : <button className={className}>{children}</button>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  PanelLeft: () => <svg data-testid="panel-left" />,
  X: () => <svg data-testid="x-icon" />,
  MessageSquare: () => <svg data-testid="msg-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
}));

// --- helpers ---

const CONV = { id: "c1", title: "Paris trip", last_message_at: "2026-06-01T10:00:00Z", message_count: 3 };

function makeOkFetch(conversations: Array<{ id: string; title: string | null; last_message_at: string | null; message_count: number | null }> = [CONV]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ conversations }),
  });
}

function makeErrorFetch(status = 503) {
  return vi.fn().mockResolvedValue({ ok: false, status });
}

function makeThrowFetch(msg = "Network failure") {
  return vi.fn().mockRejectedValue(new Error(msg));
}

// Import after mocks to pick up the stubs.
import { ConversationRailDrawer } from "@/components/crm/ConversationRailDrawer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function toggleButton() {
  return screen.getByRole("button", { name: "Toggle conversation history" });
}

async function openDrawer() {
  await act(async () => {
    fireEvent.click(toggleButton());
  });
}

// --- tests ---

describe("ConversationRailDrawer", () => {
  describe("initial state", () => {
    it("drawer is closed on mount — toggle button is present but panel is collapsed", () => {
      vi.stubGlobal("fetch", makeOkFetch());
      render(<ConversationRailDrawer />);
      const btn = toggleButton();
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("dialog")).toBeTruthy(); // exists in DOM, but off-screen
    });

    it("fetch is NOT called on mount before the drawer is opened", () => {
      const fetchMock = makeOkFetch();
      vi.stubGlobal("fetch", fetchMock);
      render(<ConversationRailDrawer />);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("toggle open/close", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", makeOkFetch([]));
    });

    it("toggle button sets aria-expanded true when opened", async () => {
      render(<ConversationRailDrawer />);
      await openDrawer();
      expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    });

    it("close button collapses the drawer", async () => {
      render(<ConversationRailDrawer />);
      await openDrawer();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close conversation history" }));
      });
      expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    });

    it("Escape key closes the drawer", async () => {
      render(<ConversationRailDrawer />);
      await openDrawer();
      await act(async () => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    });

    it("backdrop click closes the drawer", async () => {
      render(<ConversationRailDrawer />);
      await openDrawer();
      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).not.toBeNull();
      await act(async () => {
        fireEvent.click(backdrop!);
      });
      expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    });
  });

  describe("fetch — success path", () => {
    it("shows conversations after a successful fetch", async () => {
      vi.stubGlobal("fetch", makeOkFetch());
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() => expect(screen.getByText("Paris trip")).toBeTruthy());
    });

    it("shows 'No conversations yet.' when the list is empty", async () => {
      vi.stubGlobal("fetch", makeOkFetch([]));
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() => expect(screen.getByText("No conversations yet.")).toBeTruthy());
    });

    it("does NOT re-fetch when the drawer is closed then re-opened after a success", async () => {
      const fetchMock = makeOkFetch();
      vi.stubGlobal("fetch", fetchMock);
      render(<ConversationRailDrawer />);

      // open → data loads → close → open again
      await openDrawer();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close conversation history" }));
      });
      await openDrawer();

      // still just 1 call — hasFetched.current guard held
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry mechanic — HTTP error path", () => {
    it("shows an error message when the API returns a non-ok status", async () => {
      vi.stubGlobal("fetch", makeErrorFetch(503));
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() =>
        expect(screen.getByText("Could not load conversations (HTTP 503)")).toBeTruthy(),
      );
    });

    it("retries on re-open after an HTTP error (hasFetched.current reset)", async () => {
      // First call fails, second succeeds.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [CONV] }) });
      vi.stubGlobal("fetch", fetchMock);
      render(<ConversationRailDrawer />);

      // open → error
      await openDrawer();
      await waitFor(() => screen.getByText("Could not load conversations (HTTP 503)"));

      // close
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close conversation history" }));
      });

      // re-open → second fetch fires → data renders
      await openDrawer();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("Paris trip")).toBeTruthy());
    });
  });

  describe("retry mechanic — network throw path", () => {
    it("shows the error message when fetch throws", async () => {
      vi.stubGlobal("fetch", makeThrowFetch("Network failure"));
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() =>
        expect(screen.getByText("Network failure")).toBeTruthy(),
      );
    });

    it("retries on re-open after a thrown fetch error (hasFetched.current reset)", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network failure"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [CONV] }) });
      vi.stubGlobal("fetch", fetchMock);
      render(<ConversationRailDrawer />);

      // open → error
      await openDrawer();
      await waitFor(() => screen.getByText("Network failure"));

      // close
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close conversation history" }));
      });

      // re-open → second fetch fires → data renders
      await openDrawer();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByText("Paris trip")).toBeTruthy());
    });
  });

  describe("conversations rendering", () => {
    it("renders a link per conversation with the correct href", async () => {
      vi.stubGlobal("fetch", makeOkFetch());
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() => {
        const link = screen.getByRole("link", { name: /paris trip/i });
        expect(link.getAttribute("href")).toBe("/concierge?c=c1");
      });
    });

    it("falls back to 'Untitled conversation' when title is null", async () => {
      vi.stubGlobal("fetch", makeOkFetch([{ ...CONV, title: null }]));
      render(<ConversationRailDrawer />);
      await openDrawer();
      await waitFor(() =>
        expect(screen.getByText("Untitled conversation")).toBeTruthy(),
      );
    });

    it("shows the loading placeholder before fetch resolves", async () => {
      // Never-resolving promise so we can inspect intermediate state.
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      render(<ConversationRailDrawer />);
      await openDrawer();
      expect(screen.getByText("Loading…")).toBeTruthy();
    });
  });
});
