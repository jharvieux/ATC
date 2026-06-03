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
    <main className="px-6 py-10 max-w-[720px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-muted-foreground text-[14px] mb-9">
        Manage your workspace configuration, team, and billing.
      </p>

      <div className="flex flex-col gap-9">
        {SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-2.5">
              {section.heading}
            </h2>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-col px-3.5 py-3 border border-border rounded-lg no-underline bg-card hover:bg-accent transition-colors"
                >
                  <span className="font-semibold text-[14px] text-foreground">{item.label}</span>
                  <span className="text-[13px] text-muted-foreground mt-0.5">{item.desc}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
