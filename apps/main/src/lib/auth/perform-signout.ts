// Issue #675 — Sign-out callback shared by SiteHeaderMenu and any other
// surface that wants the same behavior.
//
// Two business invariants this helper exists to enforce — both have been
// the cause of real UX bugs in the past:
//
// 1. After POST /api/auth/signout, the page MUST navigate to "/" so server
//    components re-render with the cookie cleared. router.push() won't do
//    that on its own (the React tree caches RSC payloads); window.location
//    is the only way to guarantee a fresh render with the new cookie state.
//
// 2. If the fetch errors (network failure, 500, whatever), the navigation
//    MUST still happen. Otherwise the user's session is server-side cleared
//    but their client still shows the authenticated UI — a stuck-logged-in
//    state from which the user can't recover except by reloading.

export function performSignout(): void {
  // .finally() runs whether the fetch resolves OR rejects, so the redirect
  // is guaranteed. Returning the promise would let callers await it, but
  // the only caller today is a Radix onSelect handler that doesn't want a
  // promise back. void keeps the discard explicit.
  void fetch("/api/auth/signout", { method: "POST" })
    .finally(() => {
      // globalThis.location works in both Node tests (overridable) and the
      // browser; window.location would be a ReferenceError under any
      // non-DOM runtime.
      globalThis.location.assign("/");
    })
    // Without a terminal .catch the rejected fetch becomes an unhandled
    // rejection (.finally rethrows). The navigation has already fired in
    // .finally so the user is leaving the page anyway — silently swallowing
    // the network error is correct here.
    .catch(() => { /* navigation already triggered */ });
}
