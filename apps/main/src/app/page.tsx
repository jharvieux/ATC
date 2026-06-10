// Dispatch lives here (not in /api/auth/callback) so post-login routing
// has a single source of truth — adding it to the callback would mean
// keeping two redirect tables in sync. See resolve-post-login.ts.

/* eslint-disable @next/next/no-img-element */

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
import { fetchTenantBranding } from "@/lib/branding/fetch-tenant-branding";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { getCachedUser } from "@/lib/auth/get-cached-user";
import { TenantShell } from "@/components/tenant-shell/TenantShell";
import { ChatExperience } from "@/components/chat/ChatExperience";

export default async function HomePage() {
  // Compute header props (which already does a getUser) before deciding
  // whether to dispatch — that way anonymous visitors hit getUser exactly
  // once instead of twice (the dispatcher would also call it). Authenticated
  // visitors redirect so the second call inside resolvePostLogin is fine.
  const headerProps = await getSiteHeaderProps();
  const incoming = await headers();

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
      // redirected to /crm/contacts or /chat. Platform admins and
      // onboarding-incomplete staff keep their redirects, as do users
      // with no active membership in THIS tenant (e.g. staff of a
      // different tenant) — for them the old dispatch is still right.
      if (
        !headerProps.isPlatformDomain &&
        dest !== "/admin" &&
        !dest.startsWith("/onboarding")
      ) {
        const tenantId = incoming.get(RESOLVED_TENANT_ID_HEADER);
        const { user } = await getCachedUser();
        const role =
          tenantId && user ? await getTenantRole(user.id, tenantId) : null;
        if (role) {
          return (
            <TenantShell role={role}>
              <ChatExperience />
            </TenantShell>
          );
        }
      }
      redirect(dest);
    }
  }

  // Tenant-branded hero — only fires for tenant subdomains. On the
  // platform domain `branding` stays null and the generic hero renders.
  // proxy.ts emits the resolved tenant id (or the "platform" sentinel)
  // on this header — it's stripped from inbound requests so the value
  // is always middleware-set, never attacker-supplied.
  const branding = headerProps.isPlatformDomain
    ? null
    : await fetchTenantBranding(incoming.get(RESOLVED_TENANT_ID_HEADER));

  return (
    <>
      <SiteHeader {...headerProps} />
      <main>
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
          {branding ? (
            <TenantHero branding={branding} />
          ) : (
            <PlatformHero />
          )}
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

function PlatformHero() {
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

function TenantHero({ branding }: { branding: NonNullable<Awaited<ReturnType<typeof fetchTenantBranding>>> }) {
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
