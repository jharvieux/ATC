// Traveller-facing landing page. This is the hero and agent-card grid that
// used to live at "/" — the homepage now sells the platform to travel
// agents, so the consumer surface moved here rather than being dropped.
//
// Platform domain only. A tenant subdomain has its own branded hero at "/"
// and must not surface the platform's own consumer funnel.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { AgentCardGrid } from "@/components/landing/AgentCardGrid";
import { TenantTheme } from "@/components/branding/TenantTheme";

const TITLE = "Plan your cruise with an AI specialist";
const DESCRIPTION =
  "Six AI cruise specialists — Caribbean, Mediterranean, Alaska, luxury, family, and accessible travel — available 24/7 and endlessly patient. Tell one what you want and get real options back.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/travelers" },
  openGraph: {
    type: "website",
    url: "/travelers",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default async function TravelersPage() {
  const headerProps = await getSiteHeaderProps();

  // Tenant subdomains resolve their own branding and serve their own hero at
  // "/". Rendering the platform's consumer funnel under an agency's domain
  // would advertise the platform to that agency's clients.
  if (!headerProps.isPlatformDomain) notFound();

  return (
    <>
      <TenantTheme />
      <SiteHeader {...headerProps} />
      <main>
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Meet your AI travel agents
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Specialist agents for every kind of cruise — Caribbean, Mediterranean, Alaska,
            family, accessible, luxury. Available 24/7, endlessly patient.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild className="h-11 px-8 text-base">
              <Link href="/agents/quiz">Find my agent</Link>
            </Button>
            <Button asChild variant="outline" className="h-11 px-8 text-base">
              <Link href="/signup">Log in</Link>
            </Button>
          </div>
        </section>
        <AgentCardGrid />
      </main>
      <footer className="mt-16 border-t border-border">
        <nav
          aria-label="Site"
          className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-3 px-6 py-10 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-foreground">
            For travel agents
          </Link>
          <Link href="/legal/ai-disclaimer" className="hover:text-foreground">
            AI disclaimer
          </Link>
          <Link href="/legal/sub-processors" className="hover:text-foreground">
            Sub-processors
          </Link>
        </nav>
      </footer>
    </>
  );
}
