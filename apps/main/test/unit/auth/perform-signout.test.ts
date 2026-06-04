// Issue #675 — Pin the redirect-on-error invariant for performSignout.
//
// The original inline lambda in SiteHeaderMenu had no test for this and
// it's the actually-load-bearing piece: if the .finally() ever regresses
// to .then(), a fetch failure leaves the user with a server-cleared
// session and authenticated client UI — a stuck state from which they
// can only recover by reloading.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performSignout } from "@/lib/auth/perform-signout";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
let assignSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assignSpy = vi.fn();
  // jsdom-free environment — synthesize a minimal window.location with
  // just the assign() method the helper uses.
  Object.defineProperty(globalThis, "location", {
    value: { assign: assignSpy },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

async function waitForSettled(): Promise<void> {
  // .finally() schedules a microtask; a couple of awaits drain the queue.
  await Promise.resolve();
  await Promise.resolve();
}

describe("performSignout", () => {
  it("POSTs to /api/auth/signout then navigates to '/' on success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    performSignout();
    await waitForSettled();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/signout");
    expect(init.method).toBe("POST");
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("still navigates to '/' when the fetch rejects (network failure / 500)", async () => {
    // The core regression guard: if someone refactors .finally() → .then(),
    // a rejected fetch would skip the redirect and leave the user with a
    // server-cleared session and stale authenticated client UI.
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network failure"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    performSignout();
    await waitForSettled();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("does not throw synchronously when fetch rejects (the caller is a non-async event handler)", () => {
    // Radix's onSelect is sync. If performSignout ever started throwing
    // out of the handler the dropdown would close mid-render and look
    // broken. The void operator + .finally() in the impl prevents the
    // unhandled rejection from propagating to onSelect.
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network failure"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(() => performSignout()).not.toThrow();
  });
});
