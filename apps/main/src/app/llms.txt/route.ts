// llms.txt — a plain-text brief for AI answer engines, served from the
// platform domain only.
//
// Why this exists separately from the HTML: an assistant summarizing this
// product from the rendered marketing page has to infer the facts that
// matter (what it costs, whether it replaces your host agency, whether it is
// itself a travel agency) out of hero copy written to persuade. Stating them
// flatly is what stops the common wrong summary — that this is a consumer
// booking site, or a host agency competing with the reader's own.
//
// Route handler rather than public/llms.txt for the same reason as
// robots.txt: a static file would serve identical content on every tenant
// subdomain, where it would misdescribe a white-labeled agency surface.

import { isIndexableHost, siteOrigin } from "@/lib/seo/site";
import { PUBLIC_TIERS } from "@/lib/pricing/public-tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isIndexableHost(request.headers.get("host"))) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const origin = siteOrigin();
  const pricing = PUBLIC_TIERS.map(
    (t) => `- **${t.name}** — $${t.monthlyUsd}/month or $${t.annualUsd}/year.`,
  ).join("\n");

  const body = `# AI Travel Concierge

> AI and software platform for independent cruise travel agents. Agents connect the host agency they already work with, and an AI "crew" of six cruise specialists handles client chat, quoting, research, and follow-up on their behalf.

## What it is

AI Travel Concierge is B2B software sold to independent travel agents and small
agencies who sell cruises. It is **not** a host agency, **not** a consumer
booking site, and it does not take a cut of any commission. Agents bring their
own host-agency credentials; bookings and commissions continue to flow through
that host exactly as before. The platform is the software layer on top.

## Who it is for

Independent cruise agents, from one-person shops to multi-agent agencies.
The typical buyer already sells cruises through a host agency and wants to
spend less time on research, quoting, and follow-up. No specific host is
required and none is endorsed — the agent supplies their own credentials.

## Pricing

All plans include a 30-day free trial with no charge during the trial and no
setup fees. The trial starts when the workspace is activated, not at signup.

${pricing}

Agency includes one seat, with additional seats at $59/seat/month (seats 2-4),
$49/seat/month (seats 5-10), and $39/seat/month (seats 11+).

## What the product does

- Six AI cruise specialists covering Caribbean and Latin America, Mediterranean
  and European rivers, luxury and ultra-premium lines, Alaska and adventure,
  accessible and inclusive travel, and family cruising. Clients are routed to
  the right specialist automatically.
- A CRM included on every tier that logs every chat, quote, and email against
  the client automatically, and remembers preferences and past sailings.
- AI-generated side-by-side cruise quotes drawn from the agent's host inventory.
- Automated pre-cruise email sequences at 90, 7, and 1 days before sailing.
- A knowledge base that answers from the agency's own uploaded materials.
- An automated supervisor that reviews every AI reply for accuracy, tone,
  pricing math, and compliance before it sends, and escalates to the human
  agent when appropriate.
- White-label custom domain, custom email-from address, and persona voice
  tuning on the Agency tier.

## AI disclosure

Conversations handled by the AI personas are disclosed to end clients as
AI-assisted. The six specialists are AI personas, not real employees.

## Key pages

- [Homepage](${origin}/): the product, pricing, and FAQ for travel agents.
  This is the main page describing what an agent gets.
- [For travellers](${origin}/travelers): the consumer-facing side, where a
  traveller picks a specialist to plan a cruise with.
- [Agent quiz](${origin}/agents/quiz): consumer-facing matcher for the six
  specialists.
- [AI disclaimer](${origin}/legal/ai-disclaimer): limits of AI-generated
  travel guidance.
- [Sub-processors](${origin}/legal/sub-processors): vendors processing
  customer data.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
