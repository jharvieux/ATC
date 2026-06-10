// #962 — Left-nav contents for the tenant landing shell, gated by the
// signed-in user's role so viewers never see staff-only links (the RBAC
// matrix in lib/auth/permission-grants.ts would 403 them anyway; hiding
// the entries avoids dead links).
//
// Role rationale:
//   - Home ("/") differs by role (#974 operator decision 2026-06-10):
//     staff work in TA mode (trade topics, no customer guardrails), so
//     their home IS the Concierge; viewers are end customers and keep
//     the guardrailed support chat.
//   - Workspace (CRM) is staff-only: ta_chat/quotes/bookings grants
//     exclude viewers (#902).
//   - My account is self-service (conversations, price watches, privacy)
//     — READ_GRANTS territory, available to every role.
//   - Administration maps to owner-only grants (tenant_branding write,
//     team_members update_role, billing).

import type { UserRole } from "@/lib/auth/permission-grants";

export interface TenantNavItem {
  href: string;
  label: string;
}

export interface TenantNavSection {
  /** null renders the items without a section heading. */
  heading: string | null;
  roles: readonly UserRole[];
  items: readonly TenantNavItem[];
}

const ALL_ROLES = ["tenant_owner", "agent", "viewer"] as const;
const STAFF: readonly UserRole[] = ["tenant_owner", "agent"];
const VIEWER_ONLY = ["viewer"] as const;
const OWNER_ONLY = ["tenant_owner"] as const;

export const TENANT_NAV_SECTIONS: readonly TenantNavSection[] = [
  {
    heading: null,
    roles: STAFF,
    items: [{ href: "/", label: "Concierge" }],
  },
  {
    heading: null,
    roles: VIEWER_ONLY,
    items: [{ href: "/", label: "Support chat" }],
  },
  {
    heading: "Workspace",
    roles: STAFF,
    items: [
      { href: "/crm/contacts", label: "Contacts" },
      { href: "/crm/quotes", label: "Quotes" },
      { href: "/crm/bookings", label: "Bookings" },
      { href: "/crm/imports", label: "Imports" },
      { href: "/crm/reports", label: "Reports" },
    ],
  },
  {
    heading: "My account",
    roles: ALL_ROLES,
    items: [
      { href: "/settings/conversations", label: "Conversations" },
      { href: "/settings/price-watches", label: "Price watches" },
      { href: "/settings/privacy", label: "Privacy & data" },
    ],
  },
  {
    heading: "Administration",
    roles: OWNER_ONLY,
    items: [
      { href: "/settings", label: "Settings" },
      { href: "/settings/usage", label: "Usage" },
    ],
  },
];

export function navSectionsForRole(role: UserRole): TenantNavSection[] {
  return TENANT_NAV_SECTIONS.filter((s) => s.roles.includes(role));
}

export type TenantDefaultPanel = "ta-concierge" | "customer-chat";

// #974 — which experience renders at the subdomain root. Keyed off STAFF
// membership (not `role !== "viewer"`) so a future role defaults to the
// guardrailed customer chat, never the unguardrailed TA surface.
export function defaultPanelForRole(role: UserRole): TenantDefaultPanel {
  return STAFF.includes(role) ? "ta-concierge" : "customer-chat";
}
