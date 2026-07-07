// Unit tests for the screenshot-capture render guard.
//
// Intent encoded here: a wrong-state render must never become a
// customer-facing help-doc screenshot. The app rejects sessions in three
// distinct shapes (redirect to "/", in-place marketing render at "/",
// proxy inactive-site page) — the guard must reject on EACH signal
// independently, and must pass only when none fire. These tests pin that
// contract so a refactor can't silently drop a signal; the two app-copy
// literals are pinned too, so a change to them is a conscious edit here,
// not an invisible defanging.

import { describe, it, expect } from "vitest";
import {
  rejectWrongStateRender,
  LOGIN_CTA_NAME,
  INACTIVE_SITE_TEXT,
} from "../../../scripts/help-screenshots/render-guard";

const CLEAN = { landedPath: "/settings/branding", loginCtaVisible: false, inactiveSitePageVisible: false };

describe("rejectWrongStateRender", () => {
  it("accepts a render that landed on the requested path with no unauth signal", () => {
    expect(rejectWrongStateRender(CLEAN, "/settings/branding")).toBeNull();
  });

  it("rejects when the gate redirected elsewhere (assertPermissionPage → '/')", () => {
    const reason = rejectWrongStateRender({ ...CLEAN, landedPath: "/" }, "/settings/branding");
    expect(reason).toMatch(/redirected to \//);
  });

  it("rejects the in-place marketing render (covers shots targeting '/' itself)", () => {
    const reason = rejectWrongStateRender(
      { landedPath: "/", loginCtaVisible: true, inactiveSitePageVisible: false },
      "/",
    );
    expect(reason).toMatch(/unauthenticated page/);
  });

  it("rejects the proxy's inactive-site page (platform paths on tenant hosts)", () => {
    const reason = rejectWrongStateRender({ ...CLEAN, inactiveSitePageVisible: true }, "/settings/branding");
    expect(reason).toMatch(/inactive-site page/);
  });

  it("accepts an authed dashboard at '/' — same URL as marketing, distinguished by the CTA signal", () => {
    expect(
      rejectWrongStateRender({ landedPath: "/", loginCtaVisible: false, inactiveSitePageVisible: false }, "/"),
    ).toBeNull();
  });

  it("pins the app-copy literals the live probes search for", () => {
    // These mirror SiteHeader's CTA and proxy.ts's inactive-site <h1>.
    // If this test fails, the app copy changed — update render-guard.ts
    // AND re-verify the guard live (see docs/runbooks/help-docs.md).
    expect(LOGIN_CTA_NAME).toBe("Log in");
    expect(INACTIVE_SITE_TEXT).toBe("This site is not currently active");
  });
});
