// Per-agent chat route — /chat/{agent-slug}. Validates the slug against
// AGENT_CATALOG (404 otherwise), renders the shared ChatExperience with
// the slug forwarded as persona_slug on every POST /api/chat call.
//
// The route's existence is the contract Phases 5a and 5b's cards/profile
// CTAs already point at (so no follow-up wiring is needed). The chat
// backend already accepts persona_slug — see /api/chat/route.ts
// (`personaSlugInput: body.persona_slug ?? null`).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ChatExperience } from "@/components/chat/ChatExperience";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { redirectPlatformChatToBooking } from "@/lib/chat/platform-redirect";
import { NOINDEX_FOLLOW } from "@/lib/seo/site";

// /agents/[slug] is the indexable page for each specialist; this is the
// live chat surface behind it and redirects away on the platform domain.
export const metadata: Metadata = { robots: NOINDEX_FOLLOW };

interface PageParams {
  params: Promise<{ slug: string }>;
}

export default async function AgentChatPage({ params }: PageParams) {
  const { slug } = await params;
  // Validate the slug before redirecting — an invalid slug should 404
  // regardless of which subdomain we'd send the visitor to.
  const agent = AGENT_CATALOG.find((a) => a.slug === slug);
  if (!agent) notFound();
  await redirectPlatformChatToBooking(`/${slug}`);

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2">
        <div className="relative h-8 w-8 flex-none overflow-hidden rounded-full">
          <Image
            src={agent.image}
            alt={agent.name}
            fill
            sizes="32px"
            className="object-cover"
          />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">{agent.name}</span>
          <span className="text-[11px] text-muted-foreground">{agent.specialty}</span>
        </div>
        <Link
          href={`/agents/${agent.slug}`}
          className="ml-auto text-xs text-muted-foreground hover:underline"
        >
          Profile
        </Link>
      </div>
      <div className="flex-1 min-h-0">
        <ChatExperience personaSlug={agent.slug} />
      </div>
    </div>
  );
}

export function generateStaticParams() {
  return AGENT_CATALOG.map((agent) => ({ slug: agent.slug }));
}
