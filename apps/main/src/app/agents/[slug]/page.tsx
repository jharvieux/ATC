// Chat-now CTA points at /chat/[slug], a route Phase 5c will add. The
// link is intentionally live now so no follow-up wiring is needed when
// that phase lands.
//
// ISR with a 60s window: the page is statically generated at build time
// for all 6 catalog slugs (generateStaticParams), then re-fetched at
// most once per minute on the next request. Without this, the build-
// time render would freeze whatever bio the DB had at deploy, defeating
// the "admins edit without a code deploy" point of #652.
export const revalidate = 60;

import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { fetchPersonaCustomerBio } from "@/lib/agents/fetch-customer-bio";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export default async function AgentProfilePage({ params }: PageParams) {
  const { slug } = await params;
  const agent = AGENT_CATALOG.find((a) => a.slug === slug);
  if (!agent) notFound();

  const headerProps = await getSiteHeaderProps();

  // Prefer the DB-authored bio (admins edit it through /admin/personas);
  // fall back to the catalog so the page still renders if the persona
  // row is missing the field. Split on blank lines into paragraphs to
  // match the catalog's paragraph-array shape.
  const dbBio = await fetchPersonaCustomerBio(agent.slug);
  const bioParagraphs = dbBio
    ? dbBio.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0)
    : [...agent.bio];

  return (
    <>
      <SiteHeader {...headerProps} />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="relative h-40 w-40 flex-none overflow-hidden rounded-full">
            <Image
              src={agent.image}
              alt={agent.name}
              fill
              sizes="160px"
              priority
              className="object-cover"
            />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
            <p className="text-muted-foreground">{agent.specialty}</p>
            <p className="mt-2 text-base italic text-foreground/80">
              &ldquo;{agent.tagline}&rdquo;
            </p>
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-4 text-base leading-relaxed text-foreground/90">
          {bioParagraphs.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild className="h-11 px-8 text-base">
            <Link href={`/chat/${agent.slug}`}>Chat with {agent.name.split(" ")[0]}</Link>
          </Button>
          <Button asChild variant="outline" className="h-11 px-8 text-base">
            <Link href="/agents/quiz">Take the agent quiz</Link>
          </Button>
        </div>
      </main>
    </>
  );
}

export function generateStaticParams() {
  return AGENT_CATALOG.map((agent) => ({ slug: agent.slug }));
}
