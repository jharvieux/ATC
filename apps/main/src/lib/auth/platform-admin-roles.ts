// Platform-admin role vocabulary (the `platform_admins.role` CHECK enum).
//
// Roles are enforced per-route via assertPlatformRole (§811). Per-page
// enforcement via assertPlatformRolePage is partially complete — the layout
// gate checks admin-ness, individual page gates check role. Remaining per-page
// gates are tracked in issue #1002.

export const PLATFORM_ADMIN_ROLES = ["superadmin", "reviewer", "finance", "support"] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export function isPlatformAdminRole(r: string): r is PlatformAdminRole {
  return (PLATFORM_ADMIN_ROLES as readonly string[]).includes(r);
}

export const PLATFORM_ADMIN_ROLE_LABELS: Record<PlatformAdminRole, string> = {
  superadmin: "Superadmin",
  reviewer: "Reviewer",
  finance: "Finance",
  support: "Support",
};

export const PLATFORM_ADMIN_ROLE_DESCRIPTIONS: Record<PlatformAdminRole, string> = {
  superadmin: "Full platform access, including managing other platform admins.",
  reviewer: "Tenant onboarding review, content moderation, and abuse signals.",
  finance: "Commissions, payouts, and billing oversight.",
  support: "Customer and tenant support, help triage.",
};
