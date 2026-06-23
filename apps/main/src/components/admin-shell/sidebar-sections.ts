// Source of truth for the platform-admin sidebar's grouped navigation.
// Matches the existing groupings on the /admin hub page so the sidebar
// and the hub stay structurally aligned — same labels, same order, same
// destinations. When you add a new admin page, add it here too (and the
// hub page if you want it surfaced as a card).
//
// requiredRoles: roles that may see this item. Omit to allow all admins.
// Superadmin access depends on including "superadmin" in requiredRoles —
// there is no automatic bypass. Every restricted item must list "superadmin"
// explicitly if superadmins should see it.

import type { PlatformAdminRole } from "@/lib/auth/platform-admin-roles";

export interface AdminNavItem {
  href: string;
  label: string;
  /** Roles that may access this page. Must include "superadmin" for superadmin access. */
  requiredRoles?: PlatformAdminRole[];
}

export interface AdminNavSection {
  heading: string;
  items: AdminNavItem[];
  /** If set, the whole section is hidden unless the role matches. */
  requiredRoles?: PlatformAdminRole[];
}

export const ADMIN_NAV_SECTIONS: AdminNavSection[] = [
  {
    heading: "Tenants & Access",
    items: [
      { href: "/admin/tenants/review-queue", label: "Tenant Review Queue", requiredRoles: ["superadmin"] },
      { href: "/admin/abuse-monitoring",     label: "Abuse Monitoring",    requiredRoles: ["superadmin"] },
      { href: "/admin/denylist",             label: "Content Deny-list",   requiredRoles: ["superadmin", "reviewer"] },
      { href: "/admin/admins",               label: "Platform Admins",            requiredRoles: ["superadmin"] },
    ],
  },
  {
    heading: "Content & Knowledge",
    requiredRoles: ["superadmin", "reviewer"],
    items: [
      { href: "/admin/personas",                label: "Personas",                   requiredRoles: ["superadmin"] },
      { href: "/admin/rag/authority",           label: "RAG Authority Overrides" },
      { href: "/admin/retrieval-weights",       label: "Retrieval Weights" },
      { href: "/admin/chunks/post-termination", label: "Post-termination Chunks" },
      { href: "/admin/travel-news",             label: "Travel News Feeds" },
      { href: "/admin/cruise-catalog",          label: "Cruise Catalog" },
    ],
  },
  {
    heading: "Legal & Compliance",
    requiredRoles: ["superadmin"],
    items: [{ href: "/admin/legal-docs", label: "Legal Documents" }],
  },
  {
    heading: "Support & Operations",
    items: [
      { href: "/admin/help-triage",           label: "Help Triage",               requiredRoles: ["superadmin", "support"] },
      { href: "/admin/pricing",               label: "Subscription Pricing",       requiredRoles: ["superadmin", "finance"] },
      { href: "/admin/reconciliation",        label: "Commission Reconciliation",  requiredRoles: ["superadmin", "finance"] },
      { href: "/admin/resources",             label: "Cost & Resource Monitoring", requiredRoles: ["superadmin", "finance"] },
      { href: "/admin/vendor-status",         label: "Vendor Status",             requiredRoles: ["superadmin", "support"] },
      { href: "/admin/email-samples",         label: "Email Samples",             requiredRoles: ["superadmin", "support", "reviewer"] },
      { href: "/admin/integrations/weather",  label: "Weather Integration",       requiredRoles: ["superadmin"] },
    ],
  },
  {
    heading: "Dashboards",
    items: [{ href: "/supervisor", label: "Supervisor" }],
  },
];

/** Returns the sections (and items within each section) visible to the given role. */
export function filterNavForRole(
  role: PlatformAdminRole | "service",
): AdminNavSection[] {
  return ADMIN_NAV_SECTIONS.flatMap((section) => {
    if (section.requiredRoles && !section.requiredRoles.includes(role as PlatformAdminRole)) {
      return [];
    }
    const items = section.items.filter(
      (item) => !item.requiredRoles || item.requiredRoles.includes(role as PlatformAdminRole),
    );
    if (items.length === 0) return [];
    return [{ ...section, items }];
  });
}
