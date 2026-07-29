// The agency (prong 2) marketing landing page. Rendered at "/" on the
// platform domain — never on a tenant subdomain, where showing an agency
// our own pricing to that agency's own customers would be a white-label
// leak. The caller owns that gate; see app/page.tsx.
//
// Lived at app/for-agencies/page.tsx until it became the homepage; that
// route is now a permanent redirect here.

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/branding/Logo";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { AgencyPricing } from "@/components/marketing/AgencyPricing";
import { JsonLd } from "@/components/seo/JsonLd";
import {
  faqJsonLd,
  softwareApplicationJsonLd,
} from "@/lib/seo/structured-data";
import { tierByName } from "@/lib/pricing/public-tiers";

const research = tierByName("Research");
const professional = tierByName("Professional");
const agency = tierByName("Agency");

type CruiseEmail = {
  badge: string;
  date: string;
  subject: string;
  to: string;
  tag: string;
  lead: string;
  bullets: { label: string; text: string }[];
  close: string;
};

const emails: CruiseEmail[] = [
  {
    badge: "90 days out",
    date: "~ Jul 5, 2026",
    subject: "90 days to Alaska — let's lock in your Norwegian Bliss adventure",
    to: "To: Janet & Mike R.",
    tag: "AI-drafted · you approve before send",
    lead: "Hi Janet & Mike — only 90 days until you sail round-trip from Seattle on Norwegian Bliss (Oct 3). Here is how we make the most of the countdown:",
    bullets: [
      { label: "Book your shore excursions now", text: "the best ones sell out first. My picks: Mendenhall Glacier & whale-watching in Juneau, the White Pass & Yukon Route Railroad in Skagway, and Misty Fjords flightseeing in Ketchikan." },
      { label: "Glacier Bay is a scenic-cruising day", text: "nothing to book — National Park rangers come aboard to narrate. I will grab you a window seat in the forward Observation Lounge." },
      { label: "Reserve specialty dining", text: "while pre-cruise pricing is lower, and consider a beverage or Wi-Fi package." },
      { label: "Documents", text: "this is a closed-loop sailing, so a passport OR a birth certificate + photo ID works. Reply and I will confirm what you have on file." },
    ],
    close: "Want me to book those excursions and dining for you? Just say the word.",
  },
  {
    badge: "7 days out",
    date: "~ Sep 26, 2026",
    subject: "7 days out — your Alaska week-ahead checklist",
    to: "To: Janet & Mike R.",
    tag: "AI-drafted · auto-scheduled",
    lead: "One week to Seattle! A few things to wrap up so embarkation day is smooth:",
    bullets: [
      { label: "Complete online check-in", text: "it is open now — pick your arrival time and I will save your boarding pass and luggage tags." },
      { label: "Pack for October in Alaska", text: "layers, a waterproof shell, comfortable walking shoes, and binoculars for Glacier Bay wildlife. Evenings run in the 40s–50s °F." },
      { label: "Your week at a glance", text: "Seattle → Juneau → Skagway → Glacier Bay (scenic) → Ketchikan → Seattle." },
      { label: "Carry-on essentials", text: "medications, chargers, and a power bank for all those photos." },
    ],
    close: "Your booked excursions are confirmed. Anything you would like to add before they sell out?",
  },
  {
    badge: "1 day out",
    date: "~ Oct 2, 2026",
    subject: "Bon voyage tomorrow — your embarkation-day game plan",
    to: "To: Janet & Mike R.",
    tag: "AI-drafted · day-before",
    lead: "Tomorrow is the day! Here is your simple game plan so you are aboard and relaxing in no time:",
    bullets: [
      { label: "Terminal", text: "Pier 66, Bell Street Cruise Terminal in downtown Seattle. Arrive at your selected check-in time — not earlier — to keep your line short." },
      { label: "Have ready", text: "your boarding pass, passport or ID, and printed luggage tags on each bag." },
      { label: "Once aboard", text: "the ship sails around 4:00 PM. Grab lunch, then head to the Observation Lounge as you cruise out through Puget Sound." },
      { label: "Muster check-in", text: "do it on the app before the sail-away party." },
    ],
    close: "I am one text away all week if anything comes up. Have an incredible trip!",
  },
];

const comparison = [
  { feature: "AI chat with all 6 specialists", r: true, p: true, a: true },
  { feature: "Built-in CRM & client memory", r: true, p: true, a: true },
  { feature: "Instant AI quotes", r: true, p: true, a: true },
  { feature: "Knowledge base (RAG) answers", r: true, p: true, a: true },
  { feature: "Booking flow", r: true, p: true, a: true },
  { feature: "Group bookings", r: false, p: true, a: true },
  { feature: "Client forum chat", r: false, p: true, a: true },
  { feature: "Gmail integration", r: false, p: true, a: true },
  { feature: "Supervisor quality dashboard", r: false, p: true, a: true },
  { feature: "Rename AI personas", r: false, p: true, a: true },
  { feature: "Custom domain & email-from", r: false, p: false, a: true },
  { feature: "Remove Powered-by branding", r: false, p: false, a: true },
  { feature: "Fine-tune persona instructions", r: false, p: false, a: true },
  { feature: "Additional agent seats", r: false, p: false, a: true },
];

const supervisorChecks = [
  "Hallucination check",
  "Stays on-persona",
  "No over-promising",
  "Pricing math verified",
  "Compliance language",
  "Tone consistency",
  "Escalates when needed",
];

// The first seven entries run setup → cost → host/commissions → trial →
// white-label → solo → safety. Setup and cost lead deliberately: they're
// the objections agents raise BEFORE they'll consider the product at all.
//
// Where each came from, against docs/marketing/byo-agency-landing.html:
//   - setup — compresses that document's "Live in an afternoon" section,
//     not its FAQ.
//   - cost — appears nowhere in that document; written for #685.
//   - the other five — from its FAQ section ("Things agents ask us
//     first"), in that section's order, with its two separate
//     host-agency and commissions questions merged into one.
//
// The §N markers elsewhere in this file are this component's own section
// numbering, from #685. They are not positions in that document (its
// layout runs how-it-works → features → personas; §5/§6 invert the last
// two) and not TechSpec sections — a bare "spec §9" here was read as
// specs/TechSpec/section-09 ("AI Personas") twice.
const faqs = [
  {
    q: "How long does setup take?",
    a: "An afternoon. Add your host credentials, your six specialists are ready out of the box, and you share your chat link. No migration, no IT, no data entry — most agents quote a client the same day.",
  },
  {
    q: "Is it worth the monthly cost?",
    a: "A single cruise commission usually covers a year of the software. If the AI saves you a few hours a week and helps you close one extra booking, it has more than paid for itself.",
  },
  {
    q: "Do I keep my host and commissions?",
    a: "Yes — you bring your own host credentials and bookings/commissions flow through your existing host exactly as today. We're the software layer on top, never in the middle of your money.",
  },
  {
    q: "How does the free trial work?",
    a: "Every paid tier includes a 30-day free trial. The clock starts when you activate your workspace — not the moment you sign up — and you are not charged during the trial. Cancel any time before it ends and you will not pay a thing.",
  },
  {
    q: "Can I put my own brand on it?",
    a: "Yes, on the Agency tier. You get a custom domain, send from your own email-from address, can remove the Powered-by branding, and can rename and fine-tune the AI personas. Professional lets you rename the personas; Agency lets you fine-tune how they speak.",
  },
  {
    q: "What if I am a one-person shop?",
    a: "Start on Research ($19/mo) to try the AI chat, CRM, and quoting, or go straight to Professional ($59/mo) for the full single-agent toolkit including Gmail and the supervisor dashboard. Upgrade to Agency and add seats whenever you grow.",
  },
  {
    q: "Is the AI safe to put in front of my clients?",
    a: "Yes. Every AI reply runs through an automated supervisor that checks accuracy, tone, over-promising, pricing math, and compliance language before it is sent, and escalates to you when a human should take over. Clients always see a clear AI-assisted disclosure.",
  },
  // Questions below were added for answer-engine coverage: they are the
  // literal phrasings an agent types into an AI assistant ("what does X
  // cost", "does it work with my host"). Every answer restates a claim
  // already made elsewhere on this page — nothing new is promised here.
  {
    q: "What does AI Travel Concierge cost?",
    a: `There are three plans, all with a 30-day free trial and no setup fees. Research is $${research.monthlyUsd}/month ($${research.annualUsd}/year) for AI chat, CRM, and quoting. Professional is $${professional.monthlyUsd}/month ($${professional.annualUsd}/year) and adds Gmail integration, group bookings, and the supervisor dashboard. Agency starts at $${agency.monthlyUsd}/month ($${agency.annualUsd}/year) for the first seat and adds white-label custom domains plus additional seats on a volume ladder.`,
  },
  {
    q: "Which host agencies does it work with?",
    a: "Any of them. You add the host-agency credentials you already use, and bookings and commissions keep flowing through that host exactly as they do today. We are the software layer on top — we never sit between you and your host, and we are not a host agency ourselves.",
  },
  {
    q: "Do I have to migrate my clients or import data to get started?",
    a: "No. There is no migration and no data entry to get running — you connect your host, your six specialists are ready out of the box, and you share your chat link. If you want your existing client email history in the system, Professional and Agency include Gmail import, but it is optional.",
  },
  {
    q: "What does the AI actually do during my workday?",
    a: "It answers client questions in chat, researches ports, ships, and cabins, builds branded side-by-side quotes from your host inventory, drafts the client email that goes with the quote, logs everything to the CRM, and sends the 90-, 7-, and 1-day pre-cruise touchpoints on schedule. You review and approve what goes out.",
  },
  {
    q: "Does it include a CRM, or do I need a separate one?",
    a: "A CRM is included on every plan, Research upward. Contacts, lead status, and full history live in one place, and every AI chat, quote, and email is logged against the client automatically. The AI also remembers cabin preferences, anniversaries, and past cruise lines, so the next conversation does not start from scratch.",
  },
  {
    q: "Can I add other agents to my account?",
    a: `Yes, on the Agency tier. The first seat is included in the $${agency.monthlyUsd}/month base, then seats 2–4 are $59/seat/month, seats 5–10 are $49/seat/month, and seats 11 and up are $39/seat/month. Agency also gives you a multi-agent supervisor view across the whole team.`,
  },
  {
    q: "What kinds of cruises do the AI specialists cover?",
    a: "Six specialists ship with every plan, covering Caribbean and Latin America, Mediterranean and European rivers, luxury and ultra-premium lines, Alaska and adventure sailings, accessible and inclusive travel, and family cruising. Clients are routed to the right specialist automatically.",
  },
  {
    q: "Will my clients know they are talking to AI?",
    a: "Yes, and that is deliberate. Every AI-handled conversation carries a clear AI-assisted disclosure, and the supervisor escalates to you whenever a human should take over. The AI is positioned as your assistant, not as a person pretending to be you.",
  },
];

function TrialButton({ className = "", children = "Start free 30-day trial" }: { className?: string; children?: ReactNode }) {
  return (
    <Button asChild className={className}>
      <Link href="/signup">{children}</Link>
    </Button>
  );
}

function LoginButton({ className = "" }: { className?: string }) {
  return (
    <Button asChild variant="ghost" className={className}>
      <Link href="/signup">Log in</Link>
    </Button>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
      {children}
    </span>
  );
}

function MockBar({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3.5 py-2.5">
      <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
      <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
      <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
      <span className="ml-2.5 flex-1 truncate rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
        {url}
      </span>
    </div>
  );
}

// Inline-avatar used inside the mock CRM table — keeps the look without
// pulling in real persona images for what is purely a visual cue.
function Initials({ initials, size = 28 }: { initials: string; size?: number }) {
  return (
    <span
      className="grid flex-none place-items-center rounded-full bg-primary/10 font-bold text-primary"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </span>
  );
}

export function AgencyLanding() {
  return (
    <div className="bg-background text-foreground">
      <JsonLd data={softwareApplicationJsonLd()} />
      <JsonLd data={faqJsonLd(faqs)} />
      {/* §0 — Nav. Logo + anchor links + Login + Trial CTA. */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-6">
          <Link href="#top" aria-label="Top of page" className="flex items-center">
            <Logo height={49} />
          </Link>
          <div className="flex items-center gap-6">
            <a href="#how" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">How it works</a>
            <a href="#features" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">Features</a>
            <a href="#personas" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">AI crew</a>
            <a href="#pricing" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">Pricing</a>
            <a href="#faq" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground md:inline">FAQ</a>
            <LoginButton className="hidden h-9 px-3 text-sm sm:inline-flex" />
            <TrialButton className="h-9 px-4 text-sm">Start free trial</TrialButton>
          </div>
        </div>
      </nav>

      {/* §1 — Hero. Outcome-led: time saved, looks bigger, research done. */}
      <header id="top" className="border-b border-border">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-20 md:grid-cols-2 md:py-24">
          <div>
            <Eyebrow>For independent cruise agents</Eyebrow>
            <h1 className="mt-4 text-4xl font-bold leading-[1.1] tracking-tight md:text-6xl">
              Sell more cruises in <em className="not-italic text-primary">half the time</em>.
            </h1>
            <p className="mt-5 max-w-[540px] text-lg text-muted-foreground">
              Your AI cruise crew quotes, researches, and follows up for you — so a single agent runs like a full agency. You keep your host and every commission; we just hand you back the hours.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <TrialButton className="h-12 px-6 text-base">Start your free 30-day trial</TrialButton>
              <Button asChild variant="outline" className="h-12 px-6 text-base">
                <a href="#how">See it work</a>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              <strong className="text-foreground">No charge during your trial.</strong> The 30 days start when you activate — not the day you sign up.
            </p>
            <p className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Bring your own host · Keep 100% of your commission · White-label on Agency
            </p>
          </div>

          <HeroChatMock />
        </div>
      </header>

      <div className="border-b border-border bg-background py-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6">
          <span className="text-xs font-medium text-muted-foreground">Works alongside the host agencies you already book with</span>
          {["Travel Leaders", "Avoya", "Cruise Planners", "+ your host"].map((h) => (
            <span key={h} className="text-sm font-semibold text-muted-foreground">{h}</span>
          ))}
        </div>
      </div>

      {/* §2 — A day on the job (new). Before / After. */}
      <section className="border-b border-border bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <div className="text-center">
            <Eyebrow>A day on the job</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Your day, minus the busywork.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">Same bookings. A fraction of the desk time.</p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-7">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Before</h3>
              <ul className="space-y-3 text-base text-muted-foreground">
                <li>An hour Googling Alaska ports.</li>
                <li>Building a quote by hand.</li>
                <li>Re-typing the same pre-cruise email.</li>
                <li>Remembering to follow up — or not.</li>
              </ul>
            </div>
            <div className="rounded-2xl border-t-4 border-primary border-x border-b border-border bg-card p-7">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-primary">After</h3>
              <p className="text-base text-foreground">
                Ask the crew. A branded quote, a drafted email, and a fully-logged CRM record are ready before your coffee&apos;s cold. The 90/7/1-day follow-ups send themselves.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* §3 — Three outcomes. Replaces "Why agents switch." */}
      <section className="py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <Eyebrow>Three outcomes</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
            Built to give you back time, status, and your evenings.
          </h2>
          <div className="mt-12 grid gap-6 text-left md:grid-cols-3">
            <OutcomeCard
              heading="Get your evenings back"
              text="Quotes in seconds, emails drafted, CRM filled in, follow-ups automatic — the AI does the desk work while you sell and live."
            />
            <OutcomeCard
              heading="Look like a bigger shop"
              text="A branded chat on your own domain, polished quotes, and emails from your address. Clients see an agency; you stay a team of one."
            />
            <OutcomeCard
              heading="The research is already done"
              text="Six specialists who know the ports, ships, and cabins cold — plus a knowledge base that answers from your own materials."
            />
          </div>
        </div>
      </section>

      {/* §4 — Live in an afternoon. Setup objection defused in the header. */}
      <section id="how" className="border-y border-border bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 py-20 text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">No migration. No IT. Live this afternoon.</h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            Connect the host you already use, meet your crew, share your link. That&apos;s the whole setup — most agents are quoting clients the same day.
          </p>
          <div className="mt-12 grid gap-6 text-left md:grid-cols-3">
            {[
              { n: "1", title: "Connect your host", text: "Add the host-agency credentials you already use. Your bookings keep flowing through them — nothing about your commission relationship changes." },
              { n: "2", title: "Meet your AI crew", text: "Six cruise specialists are ready out of the box. On Pro and Agency you can rename them to fit your brand; on Agency you can fine-tune how they speak." },
              { n: "3", title: "Sell on your domain", text: "Share your client chat link. On the Agency tier it runs on your own custom domain and sends from your own email — fully white-labeled." },
            ].map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-border bg-card p-7">
                <div className="absolute -top-4 left-6 grid h-9 w-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                  {s.n}
                </div>
                <h3 className="mb-2 mt-3 text-lg font-semibold">{s.title}</h3>
                <p className="text-[15px] text-muted-foreground">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* §5 — Meet your AI crew. Use AGENT_CATALOG so the for-agencies
          and consumer surfaces stay in sync. */}
      <section id="personas" className="py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <Eyebrow>Meet your AI crew</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Six cruise specialists, ready on day one</h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            Each persona has a real area of expertise, and clients are routed to the right specialist automatically. Available on every tier — rename them on Pro, fine-tune their voice on Agency.
          </p>
          <div className="mt-12 grid gap-6 text-left sm:grid-cols-2 lg:grid-cols-3">
            {/* Linked, not static cards: this is now the homepage, so it is
                the only crawl path to the six /agents/[slug] profiles. */}
            {AGENT_CATALOG.map((agent) => (
              <Link
                key={agent.slug}
                href={`/agents/${agent.slug}`}
                className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-sm transition-colors hover:border-primary/40"
              >
                <div className="flex items-center gap-4">
                  <div className="relative h-16 w-16 flex-none overflow-hidden rounded-full">
                    <Image src={agent.image} alt={agent.name} fill sizes="64px" className="object-cover" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold">{agent.name}</h3>
                    <p className="text-sm text-primary">{agent.specialty}</p>
                  </div>
                </div>
                <p className="text-sm italic text-muted-foreground">&ldquo;{agent.tagline}&rdquo;</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* §6 — Inside the platform. Three retained mockups: CRM, quote,
          pre-cruise email sequence. Restyled to tokens. */}
      <section id="features" className="border-y border-border bg-muted/30 py-20">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center">
            <Eyebrow>Inside the platform</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">A complete cruise-selling workspace</h2>
          </div>

          <div className="mt-12 grid items-center gap-12 md:grid-cols-2">
            <div>
              <h3 className="text-2xl font-bold tracking-tight md:text-3xl">A CRM that fills itself in</h3>
              <p className="mt-3 text-lg text-muted-foreground">
                Every chat, quote, and email is captured against the client automatically. The AI remembers preferences and past sailings, so the next conversation starts warm — not from scratch.
              </p>
              <FeatureList
                items={[
                  "Contacts, lead status, and history in one place",
                  "AI remembers cabin preferences, anniversaries, past cruise lines",
                  "Every AI quote and email logged to the client record",
                  "Included on every tier — even Research",
                ]}
              />
            </div>
            <CrmMock />
          </div>

          <div className="mt-20 grid items-center gap-12 md:grid-cols-2">
            <div className="md:order-2">
              <h3 className="text-2xl font-bold tracking-tight md:text-3xl">Quotes your clients can say yes to</h3>
              <p className="mt-3 text-lg text-muted-foreground">
                Ask the AI for options and it returns a clean, branded, side-by-side quote — pulled from your host inventory — ready to send.
              </p>
              <FeatureList
                items={[
                  "Live host inventory, not stale spreadsheets",
                  "Cabin tiers, taxes, and perks itemized automatically",
                  "One click turns a quote into a drafted client email",
                  "Group bookings on Pro and Agency",
                ]}
              />
            </div>
            <QuoteMock />
          </div>

          <div className="mt-20">
            <div className="text-center">
              <h3 className="text-2xl font-bold tracking-tight md:text-3xl">Pre-cruise emails the AI sends for you</h3>
              <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
                Content-rich touchpoints at 90, 7, and 1 days out — drafted, scheduled, and logged automatically. A real sequence for a Norwegian Bliss Alaska sailing.
              </p>
            </div>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {emails.map((e) => <EmailCard key={e.badge} email={e} />)}
            </div>
          </div>
        </div>
      </section>

      {/* §7 — Every reply checked. Supervisor / safety chips. */}
      <section className="py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <Eyebrow>AI you can put in front of clients</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Every AI reply is checked before it sends</h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            An automated supervisor reviews each response for accuracy, tone, and compliance — so the AI sounds like a seasoned agent, not a risky chatbot. Clients always see a clear AI-assisted disclosure.
          </p>
          <div className="mx-auto mt-9 flex max-w-3xl flex-wrap justify-center gap-3">
            {supervisorChecks.map((c) => (
              <div key={c} className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium">
                <span className="h-2 w-2 rounded-full bg-primary" />
                {c}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* §8 — Pricing. ROI banner above the existing pricing component. */}
      <section id="pricing" className="border-y border-border bg-muted/30 py-20">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-3xl rounded-2xl border border-primary/40 bg-primary/5 p-5 text-center text-sm text-foreground">
            <strong className="text-primary">One booking covers the whole year.</strong>{" "}
            A single cruise commission typically dwarfs a year of Professional — the only question is how many evenings it buys back.
          </div>
          <div className="mt-10 text-center">
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Simple plans. 30-day free trial on all of them.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
              Bring your own host agency on every tier. No setup fees. Cancel anytime during your trial.
            </p>
            <AgencyPricing />
          </div>
        </div>
      </section>

      {/* Compare tiers — retained from prior page, restyled to tokens. */}
      <section className="py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <Eyebrow>Compare tiers</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Exactly what is in each plan</h2>
          <div className="mt-10 overflow-x-auto text-left">
            <table className="w-full min-w-[560px] overflow-hidden rounded-2xl border border-border bg-card">
              <thead>
                <tr className="bg-muted text-foreground">
                  <th className="px-5 py-3.5 text-left text-sm font-semibold">Feature</th>
                  <th className="px-5 py-3.5 text-sm font-semibold">Research</th>
                  <th className="px-5 py-3.5 text-sm font-semibold">Professional</th>
                  <th className="px-5 py-3.5 text-sm font-semibold">Agency</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.feature} className="border-t border-border">
                    <td className="px-5 py-3.5 text-left text-sm font-medium">{row.feature}</td>
                    <Cell on={row.r} /><Cell on={row.p} /><Cell on={row.a} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* §9 — FAQ, reordered: setup → cost → host/commissions → trial → ... */}
      <section id="faq" className="border-y border-border bg-muted/30 py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <Eyebrow>Questions</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Things agents ask us first</h2>
          <div className="mx-auto mt-10 max-w-3xl text-left">
            {faqs.map((f) => (
              <details key={f.q} className="group mb-3 rounded-xl border border-border bg-card px-5">
                <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-base font-semibold [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="text-2xl font-light text-primary group-open:hidden">+</span>
                  <span className="hidden text-2xl font-light text-primary group-open:inline">−</span>
                </summary>
                <p className="pb-4 text-[15px] text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* §10 — Final CTA. */}
      <section className="py-20">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Get your evenings back this week.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Quote faster, look bigger, and let the research, follow-ups, and admin run themselves. Keep your host. Keep your commission. Free for 30 days.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <TrialButton className="h-12 px-6 text-base">Start your free trial</TrialButton>
            <LoginButton className="h-12 px-6 text-base" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            No charge during your trial · No setup fees · Cancel anytime
          </p>
        </div>
      </section>

      <footer className="border-t border-border bg-background py-14">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex flex-wrap justify-between gap-10">
            <div className="max-w-[320px]">
              <Logo height={49} decorative />
              <p className="mt-3 text-sm text-muted-foreground">
                The AI + software layer for independent cruise agents. Bring your own host agency.
              </p>
            </div>
            <div className="flex flex-wrap gap-14">
              <div>
                <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-foreground">Product</h4>
                {[["Features", "#features"], ["AI crew", "#personas"], ["Pricing", "#pricing"], ["FAQ", "#faq"]].map(([t, h]) => (
                  <a key={t} href={h} className="mb-2 block text-sm text-muted-foreground hover:text-foreground">{t}</a>
                ))}
              </div>
              <div>
                <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-foreground">Get started</h4>
                <Link href="/signup" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">Start free trial</Link>
                <Link href="/signup" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">Log in</Link>
              </div>
              {/* Sole crawl path to the traveller-facing pages now that the
                  homepage sells to agents. */}
              <div>
                <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-foreground">Travelling?</h4>
                <Link href="/travelers" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">Plan a cruise</Link>
                <Link href="/agents/quiz" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">Find my agent</Link>
                <Link href="/legal/ai-disclaimer" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">AI disclaimer</Link>
                <Link href="/legal/sub-processors" className="mb-2 block text-sm text-muted-foreground hover:text-foreground">Sub-processors</Link>
              </div>
            </div>
          </div>
          <div className="mt-10 flex flex-wrap justify-between gap-5 border-t border-border pt-6 text-xs text-muted-foreground">
            <span>© 2026 AI Travel Concierge</span>
            <span className="max-w-2xl leading-relaxed">
              Conversations handled by our AI personas are clearly disclosed as AI-assisted. Screenshots and sample emails on this page are illustrative. Pricing shown for bring-your-own-host-agency plans.
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function HeroChatMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
      <MockBar url="yourname.ai-travelconcierge.com" />
      <div className="p-5">
        <div className="mb-4 flex items-center gap-3 border-b border-border pb-3">
          <Initials initials="PS" size={40} />
          <div>
            <div className="text-sm font-semibold">Priya Sharma</div>
            <div className="text-xs text-muted-foreground">Luxury cruise concierge</div>
          </div>
          <span className="ml-auto rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
            AI-assisted chat
          </span>
        </div>
        <div className="mb-3 max-w-[86%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-sm">
          We want a luxury Mediterranean cruise for our 25th anniversary — somewhere with a quiet, adults-only feel.
        </div>
        <div className="mb-3 ml-auto max-w-[86%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
          A milestone like that deserves something special. For an intimate, refined Mediterranean sailing I would look at a ship-within-a-ship suite — a private sundeck and a dedicated concierge.
          <span className="mt-2 block rounded-xl bg-primary-foreground/10 px-2.5 py-2 text-[13px]">
            I found 3 sailings that match. Want a side-by-side quote with suite options and anniversary perks?
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
          generating quote — pulling live host inventory…
        </div>
      </div>
    </div>
  );
}

function CrmMock() {
  const rows = [
    { i: "JM", n: "Janet & Mike R.", t: "Alaska, July", s: "Hot lead" },
    { i: "DL", n: "Diane L.", t: "Mediterranean luxury", s: "Quoted" },
    { i: "TF", n: "The Foster family", t: "Caribbean, spring", s: "Booked" },
    { i: "RG", n: "Robert G.", t: "River cruise, fall", s: "Quoted" },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <MockBar url="yourname.ai-travelconcierge.com/crm" />
      <div className="p-3.5">
        <div className="grid grid-cols-[1.4fr_1fr_0.8fr] gap-2 rounded-t-lg bg-muted px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <div>Client</div><div>Interest</div><div>Status</div>
        </div>
        {rows.map((row) => (
          <div key={row.i} className="grid grid-cols-[1.4fr_1fr_0.8fr] items-center gap-2 border-b border-border px-3 py-2.5 text-[13px]">
            <div className="flex items-center gap-2.5"><Initials initials={row.i} size={28} /> {row.n}</div>
            <div className="text-muted-foreground">{row.t}</div>
            <div>
              <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium">
                {row.s}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuoteMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <MockBar url="Quote · Diane L." />
      <div className="p-5">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-muted px-5 py-4">
            <div className="text-base font-bold">7-Night Western Mediterranean</div>
            <div className="text-xs text-muted-foreground">Yacht Club Suite · Barcelona round-trip · Oct 12</div>
          </div>
          <div className="flex justify-between border-b border-border px-5 py-2.5 text-sm"><span>Suite (2 guests)</span><span>$4,180</span></div>
          <div className="flex justify-between border-b border-border px-5 py-2.5 text-sm"><span>Taxes & port fees</span><span>$398</span></div>
          <div className="flex justify-between border-b border-border px-5 py-2.5 text-sm text-muted-foreground"><span>Anniversary perk — specialty dining</span><span>included</span></div>
          <div className="flex justify-between bg-muted px-5 py-2.5 text-base font-bold"><span>Total</span><span>$4,578</span></div>
        </div>
        <div className="mt-3 flex gap-2.5">
          <span className="flex-1 rounded-full bg-primary py-2.5 text-center text-sm font-semibold text-primary-foreground">Draft email</span>
          <span className="flex-1 rounded-full border border-border bg-background py-2.5 text-center text-sm font-semibold">Save to CRM</span>
        </div>
      </div>
    </div>
  );
}

function EmailCard({ email }: { email: CruiseEmail }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border bg-muted/50 px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">{email.badge}</span>
          <span className="text-[11px] text-muted-foreground">{email.date}</span>
        </div>
        <div className="mt-2.5 text-[15px] font-semibold leading-snug">{email.subject}</div>
        <div className="mt-1 text-xs text-muted-foreground">From: you@youragency.com · {email.to}</div>
      </div>
      <div className="flex flex-1 flex-col px-5 py-4 text-[13.5px] text-foreground">
        <span className="mb-3 inline-block w-fit rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{email.tag}</span>
        <p className="mb-3">{email.lead}</p>
        <ul className="mb-3 space-y-2">
          {email.bullets.map((b) => (
            <li key={b.label} className="leading-snug">
              <strong className="text-foreground">{b.label}</strong> — <span className="text-muted-foreground">{b.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-auto text-muted-foreground">{email.close}</p>
      </div>
    </div>
  );
}

function OutcomeCard({ heading, text }: { heading: string; text: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-7 shadow-sm">
      <h3 className="text-lg font-semibold">{heading}</h3>
      <p className="mt-3 text-[15px] text-muted-foreground">{text}</p>
    </div>
  );
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 space-y-3">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-2.5 text-[15px]">
          <span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-primary/15 text-[12px] font-bold text-primary" aria-hidden>
            ✓
          </span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Cell({ on }: { on: boolean }) {
  return (
    <td className="px-5 py-3.5 text-center text-sm">
      {on ? (
        <span className="font-bold text-primary" aria-label="included">✓</span>
      ) : (
        <span className="text-muted-foreground/40" aria-label="not included">—</span>
      )}
    </td>
  );
}
