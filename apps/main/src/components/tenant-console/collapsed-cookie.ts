// Cookie-based persistence for ConsoleSidebar's collapsed-sections state.
// Same mechanism as the platform-admin sidebar (#669: server-readable so
// the initial SSR HTML already reflects the saved state — no flash), but a
// SEPARATE cookie name so a tenant owner's console preferences don't
// collide with their platform-admin preferences if they hold both roles.
//
// parse is name-agnostic (it takes the raw value the server already
// extracted by name), so we reuse it directly; only the name + serialize
// differ between the two sidebars.

import { parseCollapsedCookie } from "@/components/admin-shell/collapsed-cookie";

const COOKIE_NAME = "atc-console-sidebar-collapsed-v1";

/** Serialize the collapsed-sections map for `document.cookie = ...`. */
export function serializeCollapsedCookie(state: Record<string, boolean>): string {
  const value = encodeURIComponent(JSON.stringify(state));
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export { COOKIE_NAME, parseCollapsedCookie };
