// #1601 — Single source of truth for how proxy.ts decides tenant identity by
// path. Before this module the classification lived as five hand-maintained
// prefix lists inlined in proxy.ts (isConsolePath, isChatPath, isLoginGatedPath,
// isAuthFlowPath, PAYMENT_GATE_EXEMPT_PREFIXES). The app/ route-group tree did
// NOT feed those lists, so adding a tenant-scoped /api/foo route and forgetting
// to list it did not fail — the request silently resolved to
// `x-resolved-tenant-id: platform` and ran in the wrong tenant context.
//
// The prevention guarantee is route-classification.test.ts, which walks
// app/api/** and fails CI when a route is not covered by any bucket here. The
// buckets below are DESCRIPTIVE of proxy.ts's current behavior — moving the
// data here is behavior-neutral; the incremental win is that every NEW api
// route now forces a conscious classification.

// Exact-or-subpath match: `base` matches itself and any child segment, but not
// a sibling that merely shares a string prefix (`/api/tenant` must not swallow
// `/api/tenants`). This is the semantics proxy.ts's predicates already had for
// their path checks.
export function pathMatchesPrefix(pathname: string, base: string): boolean {
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function matchesAnyPrefix(
  pathname: string,
  bases: readonly string[],
): boolean {
  return bases.some((b) => pathMatchesPrefix(pathname, b));
}

// --- Tenant console (§ operator workspace) ------------------------------------
// On the PLATFORM domain these get a resolved tenant header instead of the
// platform sentinel (proxy.ts step 2). Pages + their API surface.
export const CONSOLE_PAGE_PREFIXES: readonly string[] = [
  "/settings",
  "/concierge",
  "/crm",
  "/groups",
];
export const CONSOLE_API_PREFIXES: readonly string[] = [
  "/api/crm",
  "/api/bookings",
  "/api/quotes",
  "/api/groups",
  "/api/price-watches",
  "/api/tenant",
];

// --- Chat + memory ------------------------------------------------------------
export const CHAT_PAGE_PREFIXES: readonly string[] = ["/chat"];
export const CHAT_API_PREFIXES: readonly string[] = ["/api/chat", "/api/memory"];

// --- Platform-admin API (§26) -------------------------------------------------
export const ADMIN_API_PREFIXES: readonly string[] = ["/api/admin"];

// --- Auth flow (§17.x) --------------------------------------------------------
// The session-establishing surface. Page + /api/auth/*.
export const AUTH_FLOW_PAGE_PREFIXES: readonly string[] = ["/auth", "/signup"];
export const AUTH_API_PREFIXES: readonly string[] = ["/api/auth"];

// --- Login-gated pages (§#1050) ----------------------------------------------
export const LOGIN_GATED_PREFIXES: readonly string[] = [
  "/signup/complete",
  "/onboarding",
];

// --- Platform-default / public API -------------------------------------------
// Everything else under /api. These do NOT get platform-domain tenant
// resolution: they are public (webhooks, health, inngest, cron, rag, public),
// platform-level (platform, security, admin-adjacent), or operator routes whose
// tenant is resolved by SUBDOMAIN (proxy.ts step 3, by slug) rather than by the
// platform-domain console list. Listed explicitly so the walk test can tell a
// consciously-platform-default route from a forgotten one.
const PLATFORM_DEFAULT_API_PREFIXES: readonly string[] = [
  "/api/agent",
  "/api/commissions",
  "/api/cron",
  "/api/cruise-lines",
  "/api/cruise-sailings",
  "/api/cruise-ships",
  "/api/draft-reply",
  "/api/email",
  "/api/extension",
  "/api/forums",
  "/api/health",
  "/api/help",
  "/api/imports",
  "/api/inngest",
  "/api/integrations",
  "/api/itineraries",
  "/api/legal",
  "/api/line-items",
  "/api/notifications",
  "/api/onboarding",
  "/api/payouts",
  "/api/platform",
  "/api/pricing",
  "/api/public",
  "/api/quote-options",
  "/api/rag",
  "/api/reports",
  "/api/resources",
  "/api/security",
  "/api/subcontractors",
  "/api/tasks",
  "/api/tenants",
  "/api/travel-news",
  "/api/user",
  "/api/voice-profiles",
  "/api/webhooks",
];

export type ApiRouteClass =
  | "admin"
  | "auth"
  | "chat"
  | "console"
  | "platform-default"
  | "unclassified";

// Classify an /api/* pathname into exactly one tenant-resolution bucket. Used
// by proxy.ts (console/chat/admin) and by the walk test, which fails when this
// returns "unclassified" — the signal that a new route was added without
// declaring how proxy.ts should resolve its tenant.
export function classifyApiRoute(pathname: string): ApiRouteClass {
  if (matchesAnyPrefix(pathname, ADMIN_API_PREFIXES)) return "admin";
  if (matchesAnyPrefix(pathname, AUTH_API_PREFIXES)) return "auth";
  if (matchesAnyPrefix(pathname, CHAT_API_PREFIXES)) return "chat";
  if (matchesAnyPrefix(pathname, CONSOLE_API_PREFIXES)) return "console";
  if (matchesAnyPrefix(pathname, PLATFORM_DEFAULT_API_PREFIXES)) return "platform-default";
  return "unclassified";
}
