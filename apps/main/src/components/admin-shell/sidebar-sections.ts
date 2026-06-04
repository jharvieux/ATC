// Source of truth for the platform-admin sidebar's grouped navigation.
// Matches the existing groupings on the /admin hub page so the sidebar
// and the hub stay structurally aligned — same labels, same order, same
// destinations. When you add a new admin page, add it here too (and the
// hub page if you want it surfaced as a card).

export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavSection {
  heading: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV_SECTIONS: AdminNavSection[] = [
  {
    heading: "Tenants & Access",
    items: [
      { href: "/admin/tenants/review-queue", label: "Tenant Review Queue" },
      { href: "/admin/abuse-monitoring", label: "Abuse Monitoring" },
      { href: "/admin/denylist", label: "Content Deny-list" },
    ],
  },
  {
    heading: "Content & Knowledge",
    items: [
      { href: "/admin/personas", label: "Personas" },
      { href: "/admin/rag/authority", label: "RAG Authority Overrides" },
      { href: "/admin/retrieval-weights", label: "Retrieval Weights" },
      { href: "/admin/chunks/post-termination", label: "Post-termination Chunks" },
      { href: "/admin/travel-news", label: "Travel News Feeds" },
    ],
  },
  {
    heading: "Legal & Compliance",
    items: [{ href: "/admin/legal-docs", label: "Legal Documents" }],
  },
  {
    heading: "Support & Operations",
    items: [
      { href: "/admin/help-triage", label: "Help Triage" },
      { href: "/admin/resources", label: "Cost & Resource Monitoring" },
      { href: "/admin/vendor-status", label: "Vendor Status" },
      { href: "/admin/email-samples", label: "Email Samples" },
      { href: "/admin/integrations/weather", label: "Weather Integration" },
    ],
  },
  {
    heading: "Dashboards",
    items: [{ href: "/supervisor", label: "Supervisor" }],
  },
];
