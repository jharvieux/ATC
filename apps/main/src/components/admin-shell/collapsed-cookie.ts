// Cookie-based persistence for AdminSidebar's collapsed-sections state.
// Was localStorage (#669): SSR couldn't see it, so every admin-page load
// flashed all-open then snapped to the operator's saved state after
// hydration. Cookies are server-readable, so the initial SSR HTML
// already reflects the persisted state — no flash.
//
// Cross-tab side-effect: cookies are shared across tabs in the same
// origin, so collapsing a section in one tab affects all open admin
// tabs. Acceptable for an admin-only surface used by one operator at
// a time.

const COOKIE_NAME = "atc-admin-sidebar-collapsed-v1";

/** Parse the cookie value back into the collapsed-sections map.
 *  Returns an empty object on any irregularity. Pure — used by both
 *  the server (cookies() in layout.tsx) and the client (document.cookie). */
export function parseCollapsedCookie(raw: string | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

/** Serialize the collapsed-sections map for writing. Client-side this
 *  is set via `document.cookie = serializeCollapsedCookie(...)`. */
export function serializeCollapsedCookie(state: Record<string, boolean>): string {
  // 1-year expiry: this is operator preference, no security concern.
  // Path=/ so any admin route sees it. SameSite=Lax matches the rest of
  // the cookie surface; the value isn't secret so HttpOnly isn't needed.
  const value = encodeURIComponent(JSON.stringify(state));
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export { COOKIE_NAME };
