// Dispatch lives here (not in /api/auth/callback) so post-login routing
// has a single source of truth — adding it to the callback would mean
// keeping two redirect tables in sync. See resolve-post-login.ts.

/* eslint-disable @next/next/no-img-element */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { AgentCardGrid } from "@/components/landing/AgentCardGrid";
import {
  resolvePostLoginDestination,
  getTenantRole,
} from "@/lib/auth/resolve-post-login";
import type { TenantBranding } from "@/lib/branding/fetch-tenant-branding";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { TenantShell } from "@/components/tenant-shell/TenantShell";
import { defaultPanelForRole } from "@/components/tenant-shell/nav-sections";
import { ChatExperience } from "@/components/chat/ChatExperience";
import { ConciergeExperience } from "@/components/concierge/ConciergeExperience";
import { JsonLd } from "@/components/seo/JsonLd";
import { organizationJsonLd, websiteJsonLd } from "@/lib/seo/structured-data";
import { AgencyLanding } from "@/components/marketing/AgencyLanding";

// §16 — tenant subdomains carry the tenant's name + favicon in the tab.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) {
    // Platform domain — the agency landing. Canonical for this content;
    // /for-agencies 308s here.
    const title =
      "AI Travel Concierge — AI software for independent cruise agents";
    const description =
      "AI cruise-selling software for independent travel agents. Six AI specialists quote, research, and follow up for you, with a built-in CRM and automatic pre-cruise emails. Bring your own host agency, keep 100% of your commission. From $19/mo with a free 30-day trial.";
    return {
      title: { absolute: title },
      description,
      alternates: { canonical: "/" },
      openGraph: { type: "website", url: "/", title, description },
      twitter: { card: "summary_large_image", title, description },
    };
  }
  return {
    // `absolute` — a bare title string would pick up the root layout's
    // "%s | AI Travel Concierge" template and stamp platform branding onto
    // Agency-tier tenants who pay specifically to remove it.
    title: { absolute: branding.display_name },
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

export default async function HomePage() {
  // Compute header props (which already does a getUser) before deciding
  // whether to dispatch — that way anonymous visitors hit getUser exactly
  // once instead of twice (the dispatcher would also call it). Authenticated
  // visitors redirect so the second call inside resolvePostLogin is fine.
  // #1792 — headerProps (DB-backed) and the incoming request headers don't
  // depend on each other; fan out instead of waiting in sequence.
  const [headerProps, incoming] = await Promise.all([getSiteHeaderProps(), headers()]);

  if (headerProps.isAuthenticated) {
    const forwarded = new Headers();
    const cookie = incoming.get("cookie");
    if (cookie) forwarded.set("cookie", cookie);
    const auth = incoming.get("authorization");
    if (auth) forwarded.set("authorization", auth);
    const dest = await resolvePostLoginDestination(
      new Request("https://placeholder.internal/", { headers: forwarded }),
    );
    if (dest) {
      // #962 — tenant-subdomain members land on the app shell at "/"
      // (collapsible nav + embedded support chat) instead of being
      // redirected to /crm/contacts or /chat. The getTenantRole() check
      // is the real gate: only users with an active membership in THIS
      // tenant see TenantShell. Users with no membership in this tenant
      // (e.g. staff of a different tenant) fall through to redirect(dest).
      // Platform admins with a tenant_owner membership (e.g. Booking tenant)
      // also land here so "Dashboard" in the hamburger works correctly;
      // platform admins with no tenant membership still redirect to /admin.
      if (
        !headerProps.isPlatformDomain &&
        !dest.startsWith("/onboarding")
      ) {
        const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);
        const { user } = await getCachedUser();
        const role =
          tenantId && user ? await getTenantRole(user.id, tenantId) : null;
        if (role) {
          // #974 — staff default to TA mode (trade chat, no customer
          // guardrails); viewers keep the guardrailed customer chat.
          return (
            <>
              <TenantTheme />
              <TenantShell
                role={role}
                branding={headerProps.tenantBranding}
                avatarUrl={headerProps.avatarUrl ?? null}
                displayName={headerProps.displayName ?? null}
              >
                {defaultPanelForRole(role) === "ta-concierge" ? (
                  <ConciergeExperience />
                ) : (
                  <ChatExperience />
                )}
              </TenantShell>
            </>
          );
        }
      }
      redirect(dest);
    }
  }

  // The platform homepage sells the platform to travel agents. The
  // traveller-facing hero and agent grid this route used to serve moved to
  // /travelers; /for-agencies permanently redirects back here.
  if (headerProps.isPlatformDomain) {
    return (
      <>
        <TenantTheme />
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={websiteJsonLd()} />
        <AgencyLanding />
      </>
    );
  }

  // Tenant subdomain — the agency's own branded hero. AgencyLanding must
  // never render past this point: it carries our pricing, our trial CTA,
  // and a "bring your own host" pitch aimed at the very agency whose
  // customers are looking at this page.
  // Request-memoized: getSiteHeaderProps already did this lookup.
  const branding = await getRequestTenantBranding();

  return (
    <>
      <TenantTheme />
      <SiteHeader {...headerProps} />
      <main>
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
          {branding ? <TenantHero branding={branding} /> : <GenericTenantHero />}
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
    </>
  );
}

// Fallback for a resolved tenant with no branding row yet. Deliberately
// says nothing about the platform — this renders under the agency's domain.
function GenericTenantHero() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        Meet your AI travel agents
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        Specialist agents for every kind of cruise — Caribbean, Mediterranean, Alaska,
        family, accessible, luxury. Available 24/7, endlessly patient.
      </p>
    </>
  );
}

function TenantHero({ branding }: { branding: TenantBranding }) {
  return (
    <>
      {branding.logo_url ? (
        <span className="inline-flex items-center">
          <img
            src={branding.logo_url}
            alt={branding.display_name}
            className="h-12 w-auto block dark:hidden"
          />
          <img
            src={branding.logo_dark_url ?? branding.logo_url}
            alt={branding.display_name}
            className="h-12 w-auto hidden dark:block"
          />
        </span>
      ) : null}
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        {branding.display_name}
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        {branding.slogan ?? "Your AI travel concierge — specialist agents for every kind of cruise, ready when you are."}
      </p>
    </>
  );
}
