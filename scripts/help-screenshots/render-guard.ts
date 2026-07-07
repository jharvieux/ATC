// Wrong-state render detection for help-doc screenshot capture.
//
// A rejected session or blocked path must never produce a screenshot that
// could ship to customers. There is no single positive "authed" marker
// across the app's three shells (site header / console / workspace
// sidebar), so we detect every wrong-state render this app actually
// produces — each verified live against the beta demo tenant:
//   1. assertPermissionPage redirects failures to "/" (never /login);
//   2. an unauthenticated "/" renders the marketing page in place,
//      recognizable by its "Log in" CTA, which no authed render shows;
//   3. the proxy answers platform paths on tenant hosts (and inactive
//      tenants) with an in-place "This site is not currently active."
//
// The decision logic is pure (unit-tested); capture.ts collects the
// signals from the live page. These two literals are the fragile part —
// they mirror app copy (SiteHeader's CTA, proxy.ts's inactive-site h1).
// If either changes in the app, update it here; the unit tests pin the
// contract so a guard refactor can't silently drop a signal.

export const LOGIN_CTA_NAME = "Log in";
export const INACTIVE_SITE_TEXT = "This site is not currently active";

export interface RenderSignals {
  /** pathname the browser actually landed on */
  landedPath: string;
  /** the marketing "Log in" CTA is visible */
  loginCtaVisible: boolean;
  /** the proxy's inactive-site page rendered */
  inactiveSitePageVisible: boolean;
}

/** Returns the rejection reason, or null when the render is safe to shoot. */
export function rejectWrongStateRender(signals: RenderSignals, wantedPath: string): string | null {
  if (signals.landedPath !== wantedPath) {
    return `session was not accepted — ${wantedPath} redirected to ${signals.landedPath}`;
  }
  if (signals.loginCtaVisible) {
    return `session was not accepted — ${wantedPath} rendered the unauthenticated page`;
  }
  if (signals.inactiveSitePageVisible) {
    return `${wantedPath} is not served on this host — proxy returned the inactive-site page`;
  }
  return null;
}
