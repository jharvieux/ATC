// §26.2 — RBAC permission matrix.
//
// The 2026-05-25 audit (Finding 5, Medium severity, wide blast radius)
// flagged that `assertPermission` was a stub: it logged the (resource,
// action) pair and proceeded, regardless of the caller's role. Every
// "permission-gated" mutating route was therefore open to any active
// tenant member.
//
// This file is the source of truth. Roles map to the set of (resource,
// action) pairs they're allowed to perform. Anything not listed is denied.
//
// CONVENTIONS:
//   - `tenant_owner` is the catch-all "owner" role. Until we model finer
//     ownership (which would require a separate role-management UI), it
//     gets every grant in the matrix.
//   - `agent` gets day-to-day operational rights. Cannot touch tenant
//     settings (branding, host_config, persona_addendum, tenant_branding).
//   - `viewer` gets read/list only.
//
// To grant a new permission: add an entry under the appropriate role(s).
// To restrict an existing permission: remove it from `agent` / `viewer`.
//
// CALL SITE: `assertPermission(req, { resource, action })` invokes
// `isPermitted(role, resource, action)` from this file. If the function
// returns false, the route returns 403.

export type UserRole = "tenant_owner" | "agent" | "viewer";

/** A grant key is "<resource>:<action>". */
type GrantKey = string;

function key(resource: string, action: string): GrantKey {
  return `${resource}:${action}`;
}

// READ-only grants — `viewer` gets exactly these. Includes customer
// self-service reads — the routes themselves scope to the caller's own
// user.id, so granting the (resource, action) does not expose other
// users' data.
const READ_GRANTS: ReadonlySet<GrantKey> = new Set([
  key("bookings", "read"),
  key("bookings.passengers", "read"),
  key("bookings.options", "read"),
  key("bug_submission", "read"),
  key("contacts", "list"),
  key("contacts", "read"),
  key("feature_request", "read"),
  key("groups", "list"),
  key("groups", "read"),
  key("help_docs", "read"),
  key("host_config", "read"),
  key("persona_addendum", "read"),
  key("price_watches", "list"),
  key("subcontractors", "read"),
  key("tasks", "list"),
  key("team_members", "list"),
  key("tenant_branding", "read"),
  // #963 — settings page shows current overrides to all roles.
  key("email_templates", "read"),
  // Customer self-service reads (§11.3 / §25.3 / §11.6). End customers
  // default to role='tenant_owner' (per migration 20260625000001), and
  // tenant staff may also use the same endpoints when acting as a user.
  key("CustomerMemory", "read"),
  key("UserProfile", "read"),
  key("PendingTransfer", "read"),
  key("SessionTransfer", "preview"),
  // §7.6 — commissions + payouts read endpoints (tenant-scoped via RLS).
  key("commissions", "read"),
  key("payouts", "read"),
  // §7.1 — /api/auth/me returns the caller's own identity + consent state.
  key("me", "get"),
  // §15.3 / §17.3 — onboarding profile read (pre-fills Edit Profile page).
  key("onboarding", "profile:read"),
]);

// AGENT grants — operational. Includes READ_GRANTS plus the day-to-day
// mutations agents perform. Excludes tenant settings (host_config write,
// tenant_branding write, persona_addendum write) — those are owner-only.
const AGENT_GRANTS: ReadonlySet<GrantKey> = new Set<GrantKey>([
  ...READ_GRANTS,
  // Bookings
  key("bookings", "cancel"),
  key("bookings", "create"),
  key("bookings", "modify"),
  key("bookings", "submit"),
  key("bookings", "update"),
  key("bookings.passengers", "write"),
  key("bookings.options", "write"),
  // Quotes
  key("quotes", "accept"),
  key("quotes", "create"),
  key("quotes", "send"),
  // Contacts
  key("contacts", "create"),
  key("contacts", "update"),
  // Tasks
  key("tasks", "create"),
  key("tasks", "delete"),
  key("tasks", "update"),
  // Groups (write side; read/list live in READ_GRANTS).
  key("groups", "broadcast"),
  key("groups", "create"),
  key("groups", "invite"),
  // Price watches
  key("price_watches", "create"),
  key("price_watches", "rearm"),
  key("price_watches", "update"),
  // Customer self-service writes (§11.3 / §25.3 / §11.6 — each route
  // scopes to caller's own user.id).
  key("CustomerMemory", "update"),
  key("CustomerMemory", "delete"),
  key("CustomerMemory", "opt_out"),
  key("UserProfile", "update"),
  key("SessionTransfer", "commit"),
  key("SessionTransfer", "discard"),
  key("SessionTransfer", "undo"),
  // Forums — operational, not moderation
  key("forums", "edit_message"),
  key("forums", "post_message"),
  key("forums", "react"),
  // Help self-service
  key("bug_submission", "create"),
  key("feature_request", "create"),
  key("help_docs", "export"),
  key("help_session", "create"),
  key("help_session", "update"),
  // §7.6 — manual payout request (tenant-owner / agent op).
  key("payouts", "request"),
  // Notifications
  key("notifications", "write"),
  // RAG submissions (operational — submit content; approve/reject is owner)
  key("rag_submissions", "create"),
  // #902 — TA-mode dashboard chat (audience='tenant_member'). Viewers
  // (customers) are explicitly excluded — they only get customer chat.
  // Note: the create-side auth for sending TA messages is enforced by
  // resolveMemberIdentity in chat/route.ts, not assertPermission — so no
  // ta_chat:create grant here (it would be stub-shaped).
  key("ta_chat", "list"),
  // #904 — draft-reply composer (assertPermission IS the route's auth gate;
  // agent + owner; viewers/customers excluded).
  key("draft_reply", "create"),
  // #903 — Voice profiles (D-193 Phase 2). Own samples + card. Both roles
  // can read/write their own data; owner additionally manages house style.
  key("voice_profile", "read"),
  key("voice_profile", "write"),
]);

// TENANT_OWNER grants — full set. AGENT_GRANTS plus owner-only.
const OWNER_GRANTS: ReadonlySet<GrantKey> = new Set<GrantKey>([
  ...AGENT_GRANTS,
  // §15.3 — onboarding profile update (owner-only: affects legal name, slug, address).
  key("onboarding", "profile:submit"),
  // Tenant settings (owner-only)
  key("host_config", "write"),
  key("tenant_branding", "write"),
  // #963 — outgoing-email template overrides affect every customer email.
  key("email_templates", "write"),
  key("persona_addendum", "write"),
  // Team management (owner-only — assigns roles to other tenant members)
  key("team_members", "update_role"),
  // Subcontractors (owner-only — affects payout flow)
  key("subcontractors", "create"),
  key("subcontractors", "delete"),
  key("subcontractors", "update"),
  // Forum moderation
  key("forums", "moderate_forum"),
  key("forums", "moderate_thread"),
  key("forums", "moderate_user"),
  // RAG content lifecycle
  key("rag_submissions", "approve"),
  key("rag_submissions", "reject"),
  key("rag_submissions", "review"),
]);

const GRANTS_BY_ROLE: Record<UserRole, ReadonlySet<GrantKey>> = {
  tenant_owner: OWNER_GRANTS,
  agent: AGENT_GRANTS,
  viewer: READ_GRANTS,
};

/**
 * Returns true iff the role has been granted the (resource, action) pair.
 * Unknown roles are treated as deny.
 */
export function isPermitted(
  role: string,
  resource: string,
  action: string,
): boolean {
  const grants = GRANTS_BY_ROLE[role as UserRole];
  if (!grants) return false;
  return grants.has(key(resource, action));
}

export function isKnownRole(role: string): role is UserRole {
  return role === "tenant_owner" || role === "agent" || role === "viewer";
}
