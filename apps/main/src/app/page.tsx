// Dispatch lives here (not in /api/auth/callback) so post-login routing
// has a single source of truth — adding it to the callback would mean
// keeping two redirect tables in sync. See resolve-post-login.ts.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { AgentCardGrid } from "@/components/landing/AgentCardGrid";
import { resolvePostLoginDestination } from "@/lib/auth/resolve-post-login";

export default async function HomePage() {
  // Compute header props (which already does a getUser) before deciding
  // whether to dispatch — that way anonymous visitors hit getUser exactly
  // once instead of twice (the dispatcher would also call it). Authenticated
  // visitors redirect so the second call inside resolvePostLogin is fine.
  const headerProps = await getSiteHeaderProps();

  if (headerProps.isAuthenticated) {
    const incoming = await headers();
    const forwarded = new Headers();
    const cookie = incoming.get("cookie");
    if (cookie) forwarded.set("cookie", cookie);
    const auth = incoming.get("authorization");
    if (auth) forwarded.set("authorization", auth);
    const dest = await resolvePostLoginDestination(
      new Request("https://placeholder.internal/", { headers: forwarded }),
    );
    if (dest) redirect(dest);
  }

  return (
    <>
      <SiteHeader {...headerProps} />
      <main>
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-20 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Meet your AI travel agents
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Specialist agents for every kind of cruise — Caribbean, Mediterranean, Alaska,
            family, accessible, luxury. Available 24/7, endlessly patient.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild className="h-11 px-8 text-base">
              <Link href="/signup">Find my agent</Link>
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
