import { describe, it, expect } from "vitest";
import { isCrossOriginRedirect } from "@/inngest/tenant-registry-reconcile";

// WHY: the reconcile fetches main's admin API with a Bearer token. If
// MAIN_APP_URL points at a host that redirects (apex→www, or the Vercel
// protection wall), following the redirect strips the bearer and yields a
// silent anonymous 200. The function uses redirect: "manual" and must treat
// any redirect as a hard failure so the misconfig is loud, not silent (#1273).
// A test that can't fail when that guard is removed would be worthless, so we
// pin both the redirect shapes Node can produce and the must-not-trip cases.
describe("isCrossOriginRedirect", () => {
  it("treats an undici opaqueredirect (status 0) as a redirect", () => {
    expect(isCrossOriginRedirect({ type: "opaqueredirect", status: 0 })).toBe(true);
  });

  it("treats raw 3xx statuses as a redirect", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(isCrossOriginRedirect({ type: "default", status })).toBe(true);
    }
  });

  it("does NOT trip on a successful 200", () => {
    expect(isCrossOriginRedirect({ type: "default", status: 200 })).toBe(false);
  });

  it("does NOT trip on 4xx/5xx — those are handled by the !res.ok branch", () => {
    // 403 (protection wall returning forbidden) and 401 (key mismatch) must
    // fall through to the explicit `returned ${status}` error, not the
    // redirect error — keeping the two failure modes diagnosable apart.
    for (const status of [400, 401, 403, 404, 500, 502]) {
      expect(isCrossOriginRedirect({ type: "default", status })).toBe(false);
    }
  });
});
