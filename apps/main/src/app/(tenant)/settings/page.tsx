// Tenant settings hub — links to all workspace settings sections.

import Link from "next/link";

const SECTIONS = [
  {
    heading: "Account",
    items: [
      { href: "/settings/billing",          label: "Billing & Subscription",  desc: "Manage your plan, payment method, and subscription status." },
      { href: "/settings/users",            label: "Team Members",             desc: "Invite agents, update roles, and manage workspace access." },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { href: "/onboarding/profile",        label: "Business Profile",         desc: "Update your agency name, legal name, address, and support contact." },
      { href: "/settings/branding",         label: "Branding",                 desc: "Logo, colors, and white-label appearance for your workspace." },
      { href: "/settings/personas",         label: "AI Personas",              desc: "Customize the six base AI personas and add your own addendums." },
      { href: "/settings/ai-mode",          label: "AI Mode",                  desc: "Set autonomous, draft-only, or disabled mode; configure background AI." },
      { href: "/settings/host-integration", label: "Host Integration",         desc: "Connect or update your host agency adapter and credentials." },
      { href: "/settings/subcontractors",   label: "Subcontractors",           desc: "Manage subcontractor agreements and commission share rates (sub-host only)." },
    ],
  },
  {
    heading: "Usage & Compliance",
    items: [
      { href: "/settings/usage",            label: "Usage",                    desc: "Current-period gauges, RAG storage status, and override requests." },
      { href: "/tenant-admin/chat-limits",  label: "Chat Limits",              desc: "Configure per-user chat-limit overrides (Pro+ only)." },
      { href: "/tenant-admin/safety",       label: "Content Safety",           desc: "Manage your workspace supplemental content deny-list (Pro+ only)." },
      { href: "/tenant-admin/crm/anonymized-notes", label: "Anonymized Notes", desc: "Review and redact notes whose customer record was removed by a CCPA purge." },
    ],
  },
];

export default function SettingsHubPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "40px 24px", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Settings</h1>
      <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 36 }}>
        Manage your workspace configuration, team, and billing.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 36 }}>
        {SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9ca3af", marginBottom: 10 }}>
              {section.heading}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: "flex", flexDirection: "column",
                    padding: "12px 14px",
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
