// Issue #699 — Pin the platform→Booking redirect contract.
//
// Three invariants:
// 1. Header "platform" → redirect to booking subdomain (preserving path suffix)
// 2. Any real tenant UUID header → NO redirect (let the page render in tenant context)
// 3. Missing header → NO redirect (let downstream guards handle it; this helper
//    is specifically for the platform sentinel, not a catch-all)

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted lets the mock factories reference the same vi.fn() instances
// the assertions use. Inline mock factories run BEFORE top-level `const`s,
// so a plain `const mockRedirect = vi.fn()` would be in the TDZ when the
// factory closure executes.
const { mockHeadersGet, mockRedirect } = vi.hoisted(() => ({
  mockHeadersGet: vi.fn(),
  mockRedirect: vi.fn((_: string): never => {
    // Next's real redirect() throws an internal error to interrupt
    // rendering. Match that contract so the caller can't accidentally
    // execute code after the redirect — that would silently leak rendering
    // on the platform domain.
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: mockHeadersGet }),
}));
vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));
vi.mock("@/lib/env", () => ({
  env: () => ({ PLATFORM_PRIMARY_DOMAIN: "ai-travelconcierge.com" }),
}));

import { redirectPlatformChatToBooking } from "@/lib/chat/platform-redirect";

beforeEach(() => {
  mockHeadersGet.mockReset();
  mockRedirect.mockClear();
});

describe("redirectPlatformChatToBooking", () => {
  it("redirects to booking subdomain when header is the 'platform' sentinel", async () => {
    mockHeadersGet.mockReturnValue("platform");
    await expect(redirectPlatformChatToBooking("")).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("https://booking.ai-travelconcierge.com/chat");
  });

  it("preserves the path suffix for per-agent chat routes", async () => {
    mockHeadersGet.mockReturnValue("platform");
    await expect(redirectPlatformChatToBooking("/marcus-cole")).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("https://booking.ai-travelconcierge.com/chat/marcus-cole");
  });

  it("does NOT redirect when a real tenant UUID is resolved (proxy auth fallback already mapped them)", async () => {
    mockHeadersGet.mockReturnValue("f5665f08-3ebb-40e0-ad6b-686f89364ad6");
    await redirectPlatformChatToBooking("");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does NOT redirect when the header is missing (the chat API guards downstream)", async () => {
    mockHeadersGet.mockReturnValue(null);
    await redirectPlatformChatToBooking("");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
