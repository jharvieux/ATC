// #962 — Left-nav and hamburger dropdown contents for the tenant shell,
// role-filtered so viewers never see staff-only links. NOTE: this filtering is
// UI convenience only (it hides dead links); it is NOT an access-control
// boundary. Real authorization is enforced per-page via assertPermission and
// the API 403s — never rely on a hidden nav entry to keep a user out.
//
// Two distinct section sets are exported:
//   sidebarSectionsForRole()   — left sidebar only; no "My account" (those
//                                live in the avatar/hamburger menu); price
//                                watches appear in Workspace for TAs so they
//                                can manage multiple customer watches.
//   hamburgerSectionsForRole() — full nav for the top-right dropdown/avatar
//                                menu, including "My account"; price watches
//                                are in My account for viewers (personal),
//                                in Workspace for staff (operational).
//   navSectionsForRole()       — alias for hamburgerSectionsForRole(), kept
//                                for backwards compatibility.
//
// Role rationale:
//   - Home ("/") differs by role (#974 operator decision 2026-06-10):
//     staff land on the TA dashboard; viewers keep the guardrailed chat.
//   - Workspace (CRM) is staff-only: ta_chat/quotes/bookings grants
//     exclude viewers (#902).
//   - Price watches are operational for TAs (many customer watches) so
//     they belong in Workspace. For customers it is personal, so My account.
//   - Admin Console is a single owner-only entry to /settings; its
//     sub-pages live in the console's own collapsible sidebar.

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

const STAFF: readonly UserRole[] = ["tenant_owner", "agent"];
const VIEWER_ONLY = ["viewer"] as const;
const OWNER_ONLY = ["tenant_owner"] as const;

// ── Sidebar sections (left rail; no My account) ──────────────────────────────

const SIDEBAR_NAV_SECTIONS: readonly TenantNavSection[] = [
  {
    heading: null,
    roles: STAFF,
    items: [{ href: "/", label: "Dashboard" }],
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
      { href: "/groups", label: "Group Bookings" },
      { href: "/crm/imports", label: "Imports" },
      { href: "/crm/reports", label: "Reports" },
      { href: "/settings/price-watches", label: "Price watches" },
    ],
  },
  {
    heading: null,
    roles: OWNER_ONLY,
    items: [{ href: "/settings", label: "Admin Console" }],
  },
];

export function sidebarSectionsForRole(role: UserRole): TenantNavSection[] {
  return SIDEBAR_NAV_SECTIONS.filter((s) => s.roles.includes(role));
}

// ── Hamburger/avatar dropdown sections (full nav including My account) ────────

const HAMBURGER_NAV_SECTIONS: readonly TenantNavSection[] = [
  {
    heading: null,
    roles: STAFF,
    items: [{ href: "/", label: "Dashboard" }],
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
      { href: "/groups", label: "Group Bookings" },
      { href: "/crm/imports", label: "Imports" },
      { href: "/crm/reports", label: "Reports" },
      { href: "/settings/price-watches", label: "Price watches" },
    ],
  },
  {
    // Staff: My account without price watches (those are in Workspace)
    heading: "My account",
    roles: STAFF,
    items: [
      { href: "/settings/conversations", label: "Conversations" },
      { href: "/settings/privacy", label: "Privacy & data" },
    ],
  },
  {
    // Viewers: My account with price watches (personal, not operational)
    heading: "My account",
    roles: VIEWER_ONLY,
    items: [
      { href: "/settings/conversations", label: "Conversations" },
      { href: "/settings/price-watches", label: "Price watches" },
      { href: "/settings/privacy", label: "Privacy & data" },
    ],
  },
  {
    heading: null,
    roles: OWNER_ONLY,
    items: [{ href: "/settings", label: "Admin Console" }],
  },
];

export function hamburgerSectionsForRole(role: UserRole): TenantNavSection[] {
  return HAMBURGER_NAV_SECTIONS.filter((s) => s.roles.includes(role));
}

/** @deprecated Use hamburgerSectionsForRole. Kept for backwards compatibility. */
export function navSectionsForRole(role: UserRole): TenantNavSection[] {
  return hamburgerSectionsForRole(role);
}

export type TenantDefaultPanel = "ta-concierge" | "customer-chat";

// #974 — which experience renders at the subdomain root. Keyed off STAFF
// membership (not `role !== "viewer"`) so a future role defaults to the
// guardrailed customer chat, never the unguardrailed TA surface.
export function defaultPanelForRole(role: UserRole): TenantDefaultPanel {
  return STAFF.includes(role) ? "ta-concierge" : "customer-chat";
}
