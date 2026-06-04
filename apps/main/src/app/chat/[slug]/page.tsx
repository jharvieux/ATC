// Per-agent chat route — /chat/{agent-slug}. Validates the slug against
// AGENT_CATALOG (404 otherwise), renders the shared ChatExperience with
// the slug forwarded as persona_slug on every POST /api/chat call.
//
// The route's existence is the contract Phases 5a and 5b's cards/profile
// CTAs already point at (so no follow-up wiring is needed). The chat
// backend already accepts persona_slug — see /api/chat/route.ts
// (`personaSlugInput: body.persona_slug ?? null`).

/* eslint-disable @next/next/no-img-element */

import { notFound } from "next/navigation";
import Link from "next/link";
import { ChatExperience } from "@/components/chat/ChatExperience";
import { AGENT_CATALOG } from "@/lib/agents/catalog";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export default async function AgentChatPage({ params }: PageParams) {
  const { slug } = await params;
  const agent = AGENT_CATALOG.find((a) => a.slug === slug);
  if (!agent) notFound();

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2">
        <img
          src={agent.image}
          alt={agent.name}
          className="h-8 w-8 rounded-full object-cover"
        />
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
