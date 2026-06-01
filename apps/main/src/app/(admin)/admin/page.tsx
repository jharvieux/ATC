// Platform admin hub — links to all admin sections.
// Auth is enforced per-route by assertPlatformAdmin; this page just navigates.

import Link from "next/link";

const SECTIONS = [
  {
    heading: "Tenants & Access",
    items: [
      { href: "/admin/tenants/review-queue", label: "Tenant Review Queue",      desc: "Approve, reject, or investigate pending tenant onboarding applications." },
      { href: "/admin/abuse-monitoring",     label: "Abuse Monitoring",         desc: "Platform-wide abuse dashboard, dimension scores, and override requests." },
      { href: "/admin/denylist",             label: "Content Deny-list",        desc: "Add or remove globally-blocked terms (hashed — terms never returned by API)." },
    ],
  },
  {
    heading: "Content & Knowledge",
    items: [
      { href: "/admin/rag/authority",        label: "RAG Authority Overrides",  desc: "Curate knowledge chunk authority — set or clear manual overrides with required reason." },
      { href: "/admin/retrieval-weights",    label: "Retrieval Weights",        desc: "Tune platform-wide composite retrieval knobs (match / authority / recency / feedback)." },
      { href: "/admin/chunks/post-termination", label: "Post-termination Chunks", desc: "Review globally-promoted chunks from terminated tenants: retain, demote, or hard-delete." },
    ],
  },
  {
    heading: "Legal & Compliance",
    items: [
      { href: "/admin/legal-docs",           label: "Legal Documents",          desc: "Publish new versions of platform legal documents (ICA, ToS, privacy policy)." },
    ],
  },
  {
    heading: "Support & Operations",
    items: [
      { href: "/admin/help-triage",          label: "Help Triage",              desc: "Review bug submissions, feature requests, and help sessions across all tenants." },
      { href: "/admin/resources",            label: "Cost & Resource Monitoring", desc: "30-day cost trends, per-model AI breakdown, tenant threshold table, pricing catalog." },
      { href: "/admin/vendor-status",        label: "Vendor Status",            desc: "Live snapshot of vendor health (AI, email, weather, payment processors)." },
      { href: "/admin/email-samples",        label: "Email Samples",            desc: "Preview and test-send any platform email template via Resend." },
      { href: "/admin/integrations/weather", label: "Weather Integration",      desc: "Inspect and manage the Open-Meteo weather integration." },
    ],
  },
];

export default function AdminHubPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "40px 24px", maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>Platform Admin</h1>
      <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 40 }}>
        All platform administration tools. Access to each section is independently gated by platform admin role.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
        {SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 12 }}>
              {section.heading}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: "flex", flexDirection: "column",
                    padding: "14px 16px",
                    border: "1px solid #e5e7eb", borderRadius: 8,
                    textDecoration: "none", color: "inherit",
                    background: "#fff",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{item.label}</span>
                  <span style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{item.desc}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
