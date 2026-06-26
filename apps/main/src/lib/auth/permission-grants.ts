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
//   - `viewer` gets read/list plus self-service writes on its OWN data
//     (chat, CustomerMemory, UserProfile, SessionTransfer). End customers
//     default to `viewer` (#969), so this is the customer-facing surface.
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
  key("group.invitations", "list"),
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
  // default to role='viewer' (least-priv column default since migration
  // 20260628000002 — #969), and tenant staff may also use the same
  // endpoints when acting as a user.
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
  // #996 — any member can view PATs that act as them; the route scopes to
  // caller's own user_id for non-owners (same self-service pattern as above).
  key("api_tokens", "list"),
  // #1173 — legal doc text (onboarding + Privacy & data page; not user-scoped).
  key("legal_document", "read"),
]);

// SELF-SERVICE grants — operations every authenticated member performs on
// their OWN data, regardless of role. ALL THREE roles inherit these. The
// routes scope to the caller's own user.id / own conversation (the chat
// routes additionally run guardConversationAccess for per-row ownership),
// so RBAC here is only the coarse "may this role use the feature" gate.
//
// #1170 — the chat history/feedback/escalate/persona ops were never in the
// matrix. When the 2026-05-25 RBAC stub (Finding 5) became real enforcement,
// every role started getting a hard 403 ("Couldn't load history: HTTP 403"),
// hidden from route tests by the tier-2 test bypass. The CustomerMemory /
// UserProfile / SessionTransfer writes had the same root cause but were
// mis-placed in AGENT_GRANTS, so customers (role='viewer') couldn't reach
// them either. Both are fixed by putting these in the shared set below.
const SELF_SERVICE_GRANTS: ReadonlySet<GrantKey> = new Set<GrantKey>([
  // §24 — customer + TA chat (shared [id] routes; guardConversationAccess
  // enforces per-row ownership, so owners/TAs reach their own threads too).
  key("Chat conversations", "list"),
  key("Get conversation", "get"),
  key("Update conversation", "patch"),
  key("Switch persona", "post"),
  key("Chat feedback", "post"),
  key("Escalate conversation", "post"),
  // §11.3 / §25.3 / §11.6 — customer self-service writes (each route scopes
  // to caller's own user.id). Moved out of AGENT_GRANTS so viewers reach them.
  key("CustomerMemory", "update"),
  key("CustomerMemory", "delete"),
  key("CustomerMemory", "opt_out"),
  key("UserProfile", "update"),
  key("SessionTransfer", "commit"),
  key("SessionTransfer", "discard"),
  key("SessionTransfer", "undo"),
  // #1173 — "My account → Privacy & data" nav section (ALL_ROLES).
  // Routes operate only on the caller's own identity/consent rows.
  key("Get consent status", "get"),
  key("Record consent", "post"),
  key("Privacy preferences", "get"),
  key("Privacy preferences update", "put"),
  key("Cookie preferences", "post"),
]);

// VIEWER grants — read/list + self-service on own data. End customers default
// to role='viewer' (#969), so this is the customer-facing surface.
const VIEWER_GRANTS: ReadonlySet<GrantKey> = new Set<GrantKey>([
  ...READ_GRANTS,
  ...SELF_SERVICE_GRANTS,
]);

// AGENT grants — operational. Includes VIEWER_GRANTS plus the day-to-day
// mutations agents perform. Excludes tenant settings (host_config write,
// tenant_branding write, persona_addendum write) — those are owner-only.
const AGENT_GRANTS: ReadonlySet<GrantKey> = new Set<GrantKey>([
  ...VIEWER_GRANTS,
  // Bookings
  key("bookings", "cancel"),
  key("bookings", "create"),
  key("bookings", "modify"),
  key("bookings", "submit"),
  key("bookings", "update"),
  key("bookings.passengers", "write"),
  key("bookings.options", "write"),
  // #1173 — bookings sub-resource reads/writes (staff-only Bookings nav).
  // Note: bookings.passengers:read and bookings.options:read live in
  // READ_GRANTS (latent over-grant, out of scope per #1173). New sub-resource
  // reads below are deliberately placed in AGENT_GRANTS to match staff-only.
  key("bookings.itinerary", "read"),
  key("bookings.itinerary", "create"),
  key("bookings.itinerary", "update"),
  key("bookings.line_items", "list"),
  key("bookings.line_items", "create"),
  key("bookings.line_items", "update"),
  key("bookings.line_items", "delete"),
  key("bookings.resources", "read"),
  key("bookings.resources", "create"),
  key("bookings.resources", "update"),
  // Quotes (#1173 — quotes:read and options sub-resource absent from matrix)
  key("quotes", "read"),
  key("quotes", "accept"),
  key("quotes", "create"),
  key("quotes", "send"),
  key("quotes.options", "list"),
  key("quotes.options", "create"),
  key("quotes.options", "update"),
  key("quotes.options", "delete"),
  key("quotes.options", "select"),
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
  key("groups", "delete"),
  key("groups", "invite"),
  key("group.invitations", "manage"),
  // Price watches
  key("price_watches", "create"),
  key("price_watches", "rearm"),
  key("price_watches", "update"),
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
  // #1173 — RAG single-chunk and batch-submit endpoints (same audience as rag_submissions:create)
  key("Submit knowledge chunk", "post"),
  key("Batch submit knowledge chunks", "post"),
  // #1173 — Reports (CRM → Reports, STAFF nav)
  key("reports.bookings_by_source", "read"),
  key("reports.campaigns", "read"),
  key("reports.campaigns", "create"),
  key("reports.cancellations", "read"),
  key("reports.first_vs_last_touch", "read"),
  key("reports.leads_by_source", "read"),
  key("reports.source_funnel", "read"),
  // #1173 — Imports (CRM → Imports, STAFF nav)
  key("imports.manual", "create"),
  key("imports.upload", "create"),
  key("imports.review", "list"),
  key("imports.review", "read"),
  key("imports.review", "accept"),
  key("imports.review", "reject"),
  key("imports.review", "retry"),
  // #1173 — CRM (Contacts, STAFF nav)
  key("crm.attribution_categories", "list"),
  key("crm.attribution_categories", "create"),
  key("crm.contacts", "edit_source"),
  // #1173 — Gmail health status pill (CRM banner; agents need read; connect is owner-only)
  key("integrations.gmail", "read"),
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
  // §15.4–§15.5 / §17.4 — onboarding wizard write actions. The operator who
  // signs up is provisioned as tenant_owner (signup/complete/route.ts), so the
  // entire wizard past the profile step is owner-driven. These were missing
  // when assertPermission's RBAC stub was replaced (2026-05-25, Finding 5),
  // 403'ing every new-agency signup at the legal step. Grant-coverage is now
  // pinned by test/unit/auth/onboarding-grants.test.ts.
  key("onboarding", "legal:accept"),
  key("onboarding", "ica:accept"),
  key("onboarding", "tier:select"),
  key("onboarding", "state_of_operation:submit"),
  key("onboarding", "branding:skip"),
  key("onboarding", "connect:setup"),
  key("onboarding", "tax_form:start"),
  key("onboarding", "subscription:setup"),
  key("onboarding", "review:submit"),
  key("onboarding", "byo:advance"),
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
  // #712 / #996 — PAT management. list is in READ_GRANTS (self-view for all
  // roles; route scopes to caller's own user_id for non-owners). create/revoke
  // remain owner-only.
  key("api_tokens", "create"),
  key("api_tokens", "revoke"),
  // §27.11 — Tenant usage dashboard + threshold-override workflow. Surfaced
  // only under the owner-only "Administration" nav section (nav-sections.ts),
  // so these are owner grants. assertPermission IS the route auth gate.
  // #1170-class gap (#1173): absent from the matrix → fail-closed 403'd the
  // /settings/usage page ("forbidden") for everyone, owners included.
  // Covers /api/tenant/usage, /api/tenant/ai-config/cost-projection (read),
  // and /api/tenant/override-requests (list + create).
  key("TenantUsage", "read"),
  key("TenantOverrideRequest", "list"),
  key("TenantOverrideRequest", "create"),
  // #1173 — tenant Administration settings (owner-only "Administration" nav)
  key("tenant.ai-config", "read"),
  key("tenant.ai-config", "tenant.config.update"),
  key("tenant.billing", "read"),
  key("tenant.billing", "manage"),
  key("tenant.personas", "read"),
  key("tenant.personas", "tenant.config.update"),
  key("tenant.sandbox", "read"),
  key("tenant.sandbox", "toggle"),
  key("Tenant chat limits", "get"),
  key("Tenant chat limits update", "put"),
  key("Tenant safety settings", "get"),
  key("Tenant safety add", "post"),
  key("Tenant safety remove", "delete"),
  // #1173 — CRM notes admin (/api/tenant/crm/notes — owner-only; PII redaction)
  key("CRM notes list", "list"),
  key("CRM note redaction", "patch"),
  // #1173 — Gmail OAuth bootstrap (route comment: "redirects the tenant admin" to Google consent)
  key("integrations.gmail", "connect"),
  // #1173 — RAG content curation (mirrors rag_submissions:approve/reject/review lifecycle)
  key("List knowledge chunks", "get"),
  key("Update knowledge chunk", "patch"),
]);

const GRANTS_BY_ROLE: Record<UserRole, ReadonlySet<GrantKey>> = {
  tenant_owner: OWNER_GRANTS,
  agent: AGENT_GRANTS,
  viewer: VIEWER_GRANTS,
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
