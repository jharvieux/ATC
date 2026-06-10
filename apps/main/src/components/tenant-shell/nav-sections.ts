// #962 — Left-nav contents for the tenant landing shell, gated by the
// signed-in user's role so viewers never see staff-only links (the RBAC
// matrix in lib/auth/permission-grants.ts would 403 them anyway; hiding
// the entries avoids dead links).
//
// Role rationale:
//   - Workspace (Concierge + CRM) is staff-only: ta_chat/quotes/bookings
//     grants exclude viewers (#902).
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
const STAFF = ["tenant_owner", "agent"] as const;
const OWNER_ONLY = ["tenant_owner"] as const;

export const TENANT_NAV_SECTIONS: readonly TenantNavSection[] = [
  {
    heading: null,
    roles: ALL_ROLES,
    items: [{ href: "/", label: "Support chat" }],
  },
  {
    heading: "Workspace",
    roles: STAFF,
    items: [
      { href: "/concierge", label: "Concierge" },
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
