// Platform-admin role vocabulary (the `platform_admins.role` CHECK enum).
//
// Access is enforced resource-centrically via assertPlatformAdminArea (§1003).
// The ADMIN_AREA_GRANTS matrix below is the single source of truth for which
// roles may access each admin area.

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
  reviewer: "RAG knowledge management, content moderation, cruise catalog, travel news, denylist, retrieval weights, feedback settings.",
  finance: "AI pricing, reconciliation, and resource utilization.",
  support: "Help triage, email samples, vendor status.",
};

// Resource-centric grants matrix. Every admin API route and page calls
// assertPlatformAdminArea(req, area) / assertPlatformAdminAreaPage(area),
// which checks this table. "superadmin" is always included implicitly —
// list it explicitly here so the type never silently diverges.
//
// Reviewer DOES NOT have access to: abuse, tenants, personas, persona_safety.
// Finance and support have clean separation — no cross-access.
export const ADMIN_AREA_GRANTS = {
  // RAG / knowledge management
  rag:               ["superadmin", "reviewer", "service"] as const,
  chunks:            ["superadmin", "reviewer"] as const,
  retrieval_weights: ["superadmin", "reviewer"] as const,
  feedback_settings: ["superadmin", "reviewer"] as const,

  // Content and catalog
  travel_news:       ["superadmin", "reviewer"] as const,
  cruise_catalog:    ["superadmin", "reviewer"] as const,
  denylist:          ["superadmin", "reviewer"] as const,

  // Support-facing
  help:              ["superadmin", "support"] as const,
  email_samples:     ["superadmin", "reviewer", "support"] as const,
  vendor_status:     ["superadmin", "support"] as const,

  // Financial
  pricing:           ["superadmin", "finance"] as const,
  ai_pricing:        ["superadmin", "finance"] as const,
  reconciliation:    ["superadmin", "finance"] as const,
  resource_util:     ["superadmin", "finance"] as const,

  // Superadmin-only
  abuse:             ["superadmin"] as const,
  tenants:           ["superadmin"] as const,
  personas:          ["superadmin"] as const,
  persona_safety:    ["superadmin"] as const,
  ai_kill_switch:    ["superadmin"] as const,
  integrations:      ["superadmin"] as const,
  legal_docs:        ["superadmin"] as const,
  pause_ai:          ["superadmin"] as const,
  admins:            ["superadmin"] as const,

  // All authenticated platform admins
  supervisor:        ["superadmin", "reviewer", "finance", "support"] as const,
} satisfies Record<string, readonly (PlatformAdminRole | "service")[]>;

export type AdminArea = keyof typeof ADMIN_AREA_GRANTS;
