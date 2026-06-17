// Source of truth for the tenant Admin Console sidebar's grouped
// navigation. Mirrors the section/order/labels of the console overview
// page (app/(console)/settings/page.tsx) so the sidebar and the overview
// stay structurally aligned. When you add a new console page, add it here
// AND to the overview's SECTIONS array.
//
// The whole console is owner-scoped today (it was previously reached only
// via the owner-only "Administration" nav group, and every page carries
// its own assertPermission gate). filterConsoleNavForRole reflects that:
// non-owners get nothing. requiredRoles per item is supported for the day
// a section needs to widen to agents — set it then, not speculatively.

import type { UserRole } from "@/lib/auth/permission-grants";

export interface ConsoleNavItem {
  href: string;
  label: string;
  /** Roles that may see this item. Omit to inherit the section's audience. */
  requiredRoles?: readonly UserRole[];
}

export interface ConsoleNavSection {
  heading: string;
  items: readonly ConsoleNavItem[];
  /** Roles that may see this whole section. Defaults to owner-only. */
  requiredRoles?: readonly UserRole[];
}

const OWNER_ONLY: readonly UserRole[] = ["tenant_owner"];

export const CONSOLE_NAV_SECTIONS: readonly ConsoleNavSection[] = [
  {
    heading: "Account",
    items: [
      { href: "/settings/billing", label: "Billing & Subscription" },
      { href: "/settings/users", label: "Team Members" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { href: "/onboarding/profile", label: "Business Profile" },
      { href: "/settings/branding", label: "Branding" },
      { href: "/settings/email-templates", label: "Email Templates" },
      { href: "/settings/personas", label: "AI Personas" },
      { href: "/settings/ai-mode", label: "AI Mode" },
      { href: "/settings/voice", label: "Voice Profile" },
      { href: "/settings/host-integration", label: "Host Integration" },
      { href: "/settings/subcontractors", label: "Subcontractors" },
    ],
  },
  {
    heading: "Developer",
    items: [{ href: "/settings/integrations", label: "API Tokens" }],
  },
  {
    heading: "Usage & Compliance",
    items: [
      { href: "/settings/usage", label: "Usage" },
      { href: "/tenant-admin/chat-limits", label: "Chat Limits" },
      { href: "/tenant-admin/safety", label: "Content Safety" },
      { href: "/tenant-admin/crm/anonymized-notes", label: "Anonymized Notes" },
    ],
  },
];

/** Sections (and items) visible to the given role. Owner-only by default. */
export function filterConsoleNavForRole(role: UserRole): ConsoleNavSection[] {
  return CONSOLE_NAV_SECTIONS.flatMap((section) => {
    const sectionRoles = section.requiredRoles ?? OWNER_ONLY;
    if (!sectionRoles.includes(role)) return [];
    const items = section.items.filter(
      (item) => !item.requiredRoles || item.requiredRoles.includes(role),
    );
    if (items.length === 0) return [];
    return [{ ...section, items }];
  });
}
