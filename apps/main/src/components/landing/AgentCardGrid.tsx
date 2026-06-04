// Agent showcase grid for the landing page. Renders the 6 agents from
// AGENT_CATALOG as cards (photo + name + specialty + tagline). The
// per-card CTAs are placeholders today: "Chat now" routes through
// /signup until Phase 5c wires per-agent chat at /chat/[slug], and
// "Full profile" goes to /agents/[slug] (which 404s until Phase 5b
// builds the profile page). Both links work after their phases ship —
// no follow-up wiring needed here.

/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AGENT_CATALOG } from "@/lib/agents/catalog";

export function AgentCardGrid(): React.ReactElement {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Six specialist agents
        </h2>
        <p className="mt-3 text-muted-foreground">
          Each one deeply expert in a corner of the cruising world. Available 24/7, endlessly patient.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {AGENT_CATALOG.map((agent) => (
          <article
            key={agent.slug}
            className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center gap-4">
              <img
                src={agent.image}
                alt={agent.name}
                className="h-20 w-20 rounded-full object-cover"
              />
              <div>
                <h3 className="text-lg font-semibold">{agent.name}</h3>
                <p className="text-sm text-muted-foreground">{agent.specialty}</p>
              </div>
            </div>
            <p className="text-sm italic text-foreground/80">&ldquo;{agent.tagline}&rdquo;</p>
            <div className="mt-auto flex gap-2 pt-2">
              <Button asChild className="h-9 flex-1 px-3 text-sm">
                <Link href={`/chat/${agent.slug}`}>Chat now</Link>
              </Button>
              <Button asChild variant="outline" className="h-9 flex-1 px-3 text-sm">
                <Link href={`/agents/${agent.slug}`}>Full profile</Link>
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
