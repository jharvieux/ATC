// Platform admin hub — links to all admin sections.
// Auth is enforced by the (admin) layout (getCachedAdminContext / notFound).
// This page additionally filters the visible cards to the caller's role so
// reviewers, finance admins, and support admins only see their own sections.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getCachedAdminContext } from "@/lib/auth/assert-platform-admin";
import type { PlatformAdminRole } from "@/lib/auth/platform-admin-roles";

type HubItem = {
  href: string;
  label: string;
  desc: string;
  requiredRoles?: PlatformAdminRole[];
};

type HubSection = {
  heading: string;
  items: HubItem[];
  requiredRoles?: PlatformAdminRole[];
};

const SECTIONS: HubSection[] = [
  {
    heading: "Tenants & Access",
    items: [
      { href: "/admin/tenants/review-queue", label: "Tenant Review Queue",   desc: "Approve, reject, or investigate pending tenant onboarding applications.", requiredRoles: ["superadmin", "reviewer"] },
      { href: "/admin/abuse-monitoring",     label: "Abuse Monitoring",      desc: "Platform-wide abuse dashboard, dimension scores, and override requests.", requiredRoles: ["superadmin", "reviewer"] },
      { href: "/admin/denylist",             label: "Content Deny-list",     desc: "Add or remove globally-blocked terms (hashed — terms never returned by API).", requiredRoles: ["superadmin", "reviewer"] },
      { href: "/admin/admins",               label: "Platform Admins",       desc: "Manage who has admin-console access and at what role (add/remove is superadmin-only)." },
    ],
  },
  {
    heading: "Content & Knowledge",
    requiredRoles: ["superadmin", "reviewer"],
    items: [
      { href: "/admin/personas",                label: "Personas",                  desc: "Edit DB-backed persona definitions and the shared safety block (legal kernel stays read-only)." },
      { href: "/admin/rag/authority",           label: "RAG Authority Overrides",   desc: "Curate knowledge chunk authority — set or clear manual overrides with required reason." },
      { href: "/admin/retrieval-weights",       label: "Retrieval Weights",         desc: "Tune platform-wide composite retrieval knobs (match / authority / recency / feedback)." },
      { href: "/admin/chunks/post-termination", label: "Post-termination Chunks",   desc: "Review globally-promoted chunks from terminated tenants: retain, demote, or hard-delete." },
      { href: "/admin/travel-news",             label: "Travel News Feeds",         desc: "Manage travel RSS feeds, trigger refreshes, and hide or promote articles to the RAG pipeline." },
      { href: "/admin/cruise-catalog",          label: "Cruise Catalog",            desc: "Manage canonical cruise lines, ships, and ports — add, disable, set tier and CruiseMapper slug." },
    ],
  },
  {
    heading: "Legal & Compliance",
    requiredRoles: ["superadmin"],
    items: [
      { href: "/admin/legal-docs", label: "Legal Documents", desc: "Publish new versions of platform legal documents (ICA, ToS, privacy policy)." },
    ],
  },
  {
    heading: "Support & Operations",
    items: [
      { href: "/admin/help-triage",          label: "Help Triage",                desc: "Review bug submissions, feature requests, and help sessions across all tenants.", requiredRoles: ["superadmin", "support"] },
      { href: "/admin/pricing",              label: "Subscription Pricing",       desc: "Edit tier base prices and seat pricing — pushes new Stripe Prices and updates the DB.", requiredRoles: ["superadmin", "finance"] },
      { href: "/admin/reconciliation",       label: "Commission Reconciliation",  desc: "Upload a CSV commission statement to auto-match line items against open bookings.", requiredRoles: ["superadmin", "finance"] },
      { href: "/admin/resources",            label: "Cost & Resource Monitoring", desc: "30-day cost trends, per-model AI breakdown, tenant threshold table, pricing catalog.", requiredRoles: ["superadmin", "finance", "support"] },
      { href: "/admin/vendor-status",        label: "Vendor Status",              desc: "Live snapshot of vendor health (AI, email, weather, payment processors).", requiredRoles: ["superadmin", "support"] },
      { href: "/admin/email-samples",        label: "Email Samples",              desc: "Preview and test-send any platform email template via Resend.", requiredRoles: ["superadmin", "support", "reviewer"] },
      { href: "/admin/integrations/weather", label: "Weather Integration",        desc: "Inspect and manage the Open-Meteo weather integration.", requiredRoles: ["superadmin"] },
    ],
  },
];

function filterSections(sections: HubSection[], role: PlatformAdminRole | "service"): HubSection[] {
  return sections.flatMap((section) => {
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

export default async function AdminHubPage() {
  const ctx = await getCachedAdminContext();
  if (!ctx) notFound();
  const visibleSections = filterSections(SECTIONS, ctx.role);

  return (
    <main className="px-6 py-10 max-w-[860px] mx-auto">
      <h1 className="text-[26px] font-bold mb-1">Platform Admin</h1>
      <p className="text-muted-foreground text-[14px] mb-10">
        All platform administration tools. Access to each section is independently gated by platform admin role.
      </p>

      <div className="flex flex-col gap-10">
        {visibleSections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mb-3">
              {section.heading}
            </h2>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-col px-4 py-3.5 border border-border rounded-lg no-underline text-foreground bg-card hover:bg-muted transition-colors"
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
