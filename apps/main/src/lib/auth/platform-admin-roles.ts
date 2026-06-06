// Platform-admin role vocabulary (the `platform_admins.role` CHECK enum).
//
// NOTE: today these roles are NOT yet enforced per-page — assertPlatformAdmin
// admits ANY platform_admin to the whole /admin surface regardless of role
// (see assert-platform-admin.ts). The first per-role gate is platform-admin
// MANAGEMENT itself: only `superadmin` may add/change/remove admins
// (assertSuperadmin). The remaining roles are labels for now; wire them into
// assertPlatformAdmin per-page when finer gating is needed.

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
