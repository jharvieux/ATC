import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AgencyPricing } from "@/components/marketing/AgencyPricing";

export const metadata: Metadata = {
  title: "AI Travel Concierge for Agencies — keep your host, add an AI crew",
  description:
    "The AI + software layer for independent cruise agents. Bring your own host agency, keep your commissions, and add six AI cruise specialists, a built-in CRM, and instant quotes. Start a free 30-day trial.",
};

const HERO_BG =
  "radial-gradient(1200px 500px at 80% -10%, rgba(6,182,196,.28), transparent 60%), radial-gradient(900px 500px at 0% 10%, rgba(79,141,249,.30), transparent 55%), linear-gradient(160deg,#0a2540 0%,#0d2f52 55%,#0b3a63 100%)";
const CORAL_BG = "linear-gradient(135deg,#ff5a3c,#ec4326)";
const FINAL_BG =
  "radial-gradient(700px 300px at 20% 0%, rgba(6,182,196,.32), transparent 60%), linear-gradient(135deg,#ff5a3c,#ec4326)";
const TRUST_BG = "linear-gradient(160deg,#0a2540,#0c3257)";

const personas = [
  { initials: "MC", name: "Marcus Cole", specialty: "Caribbean & Latin America", blurb: "Your warm, do-it-all default — equally at home with first-time cruisers and repeat Caribbean regulars.", grad: "linear-gradient(135deg,#1565d8,#4f8df9)" },
  { initials: "MB", name: "Marco Bellini", specialty: "Mediterranean & European rivers", blurb: "Old-world charm and deep knowledge of Med sailings and European river itineraries.", grad: "linear-gradient(135deg,#0891a6,#06b6c4)" },
  { initials: "PS", name: "Priya Sharma", specialty: "Luxury & suite experiences", blurb: "A Forbes five-star concierge sensibility for luxury lines and ship-within-a-ship suites.", grad: "linear-gradient(135deg,#7c5cff,#a78bfa)" },
  { initials: "DK", name: "Capt. Dave Kowalski", specialty: "Alaska & adventure", blurb: "Glaciers, expedition sailings, and the active itineraries that need a steady hand.", grad: "linear-gradient(135deg,#0f766e,#2dd4bf)" },
  { initials: "MP", name: "Maya Patel", specialty: "Accessible & inclusive travel", blurb: "An occupational-therapy background and lived experience matching every guest with the right accessible sailing.", grad: "linear-gradient(135deg,#db2777,#f472b6)" },
  { initials: "JH", name: "Jenny Hartwell", specialty: "Family cruising", blurb: "Multigenerational trips, kids programs, and the family logistics that make or break a sailing.", grad: "linear-gradient(135deg,#ea580c,#fb923c)" },
];

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
    subject: "90 days to Alaska — let’s lock in your Norwegian Bliss adventure",
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

const faqs = [
  { q: "Do I have to leave my current host agency?", a: "No — that is the whole point. You bring your own host-agency credentials and keep booking through Travel Leaders, Avoya, Cruise Planners, or whoever you use today. Your commission relationship does not change. We are the AI and software layer on top, not a new host." },
  { q: "Where do my commissions go?", a: "Straight to your existing host agency, exactly as they do now. AI Travel Concierge never sits between you and your commission — you pay us a flat subscription for the software, and that is it." },
  { q: "How does the free trial work?", a: "Every paid tier includes a 30-day free trial. The clock starts when you activate your workspace — not the moment you sign up — and you are not charged during the trial. Cancel any time before it ends and you will not pay a thing." },
  { q: "Can I put my own brand on it?", a: "Yes, on the Agency tier. You get a custom domain, send from your own email-from address, can remove the Powered-by branding, and can rename and fine-tune the AI personas. Professional lets you rename the personas; Agency lets you fine-tune how they speak." },
  { q: "What if I am a one-person shop?", a: "Start on Research ($19/mo) to try the AI chat, CRM, and quoting, or go straight to Professional ($59/mo) for the full single-agent toolkit including Gmail and the supervisor dashboard. Upgrade to Agency and add seats whenever you grow." },
  { q: "Is the AI safe to put in front of my clients?", a: "Yes. Every AI reply runs through an automated supervisor that checks accuracy, tone, over-promising, pricing math, and compliance language before it is sent, and escalates to you when a human should take over. Clients always see a clear AI-assisted disclosure." },
];

function TrialButton({ className = "", children = "Start free trial" }: { className?: string; children?: ReactNode }) {
  return (
    <Link
      href="/signup"
      className={`inline-flex items-center justify-center gap-2 rounded-full font-bold text-white shadow-[0_10px_24px_rgba(255,90,60,0.35)] transition-transform hover:-translate-y-0.5 ${className}`}
      style={{ background: CORAL_BG }}
    >
      {children}
    </Link>
  );
}

function Eyebrow({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <span className={`text-xs font-bold uppercase tracking-[0.14em] ${light ? "text-[#7ee8da]" : "text-[#0891a6]"}`}>
      {children}
    </span>
  );
}

function MockBar({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-slate-200 bg-[#f0f3f8] px-3.5 py-2.5">
      <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
      <span className="ml-2.5 flex-1 truncate rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">
        {url}
      </span>
    </div>
  );
}

function Avatar({ initials, grad, size = 40 }: { initials: string; grad: string; size?: number }) {
  return (
    <span
      className="grid flex-none place-items-center rounded-full font-bold text-white"
      style={{ background: grad, width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

export default function ForAgenciesPage() {
  return (
    <div className="bg-[#f6f9fd] text-[#16243a]">
      <nav className="sticky top-0 z-50 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-[68px] max-w-[1140px] items-center justify-between px-6">
          <a href="#top" className="flex items-center gap-2.5 text-lg font-extrabold text-[#0a2540]">
            <BrandMark />
            AI Travel Concierge
          </a>
          <div className="flex items-center gap-7">
            <a href="#how" className="hidden text-[15px] font-semibold text-slate-500 hover:text-[#16243a] md:inline">How it works</a>
            <a href="#features" className="hidden text-[15px] font-semibold text-slate-500 hover:text-[#16243a] md:inline">Features</a>
            <a href="#personas" className="hidden text-[15px] font-semibold text-slate-500 hover:text-[#16243a] md:inline">AI crew</a>
            <a href="#pricing" className="hidden text-[15px] font-semibold text-slate-500 hover:text-[#16243a] md:inline">Pricing</a>
            <a href="#faq" className="hidden text-[15px] font-semibold text-slate-500 hover:text-[#16243a] md:inline">FAQ</a>
            <TrialButton className="px-5 py-2.5 text-[15px]" />
          </div>
        </div>
      </nav>

      {/* Multi-stop radial+linear gradient — not expressible as static Tailwind */}
      <header id="top" className="relative overflow-hidden text-white" style={{ background: HERO_BG }}>
        <div className="mx-auto grid max-w-[1140px] items-center gap-12 px-6 py-20 md:grid-cols-2 md:py-24">
          <div>
            <Eyebrow light>For independent cruise agents</Eyebrow>
            <h1 className="mt-3.5 text-4xl font-extrabold leading-[1.1] md:text-[58px]">
              Keep your host.<br />Keep your commissions.<br />
              <span style={{ background: "linear-gradient(90deg,#7ee8da,#8fc2ff)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
                Add an AI crew.
              </span>
            </h1>
            <p className="mt-5 max-w-[540px] text-xl text-[#cfe0f5]">
              {"AI Travel Concierge is the AI + software layer for cruise specialists who already have a host agency. Your bookings still flow through Travel Leaders, Avoya, Cruise Planners — whoever you book with today. We just give you six AI cruise experts, a built-in CRM, instant quotes, and a white-label client experience."}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3.5">
              <TrialButton className="px-9 py-4 text-lg">Start your free 30-day trial</TrialButton>
              <a href="#how" className="inline-flex items-center justify-center rounded-full border border-white/35 bg-white/10 px-9 py-4 text-lg font-bold text-white hover:bg-white/20">
                See how it works
              </a>
            </div>
            <p className="mt-4 text-sm text-[#9fb6d4]">
              <b className="text-[#cfe6ff]">No charge during your trial.</b>{" "}
              {"The 30 days start when you activate — not the day you sign up."}
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              {["Bring your own host credentials", "Cruise-specialized AI", "White-label on the Agency tier"].map((p) => (
                <span key={p} className="rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-[13px] font-semibold text-[#e7f0fb]">
                  {p}
                </span>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/50 bg-white shadow-[0_30px_70px_rgba(0,0,0,0.4)]">
            <MockBar url="yourname.ai-travelconcierge.com" />
            <div className="p-[18px] text-[#16243a]">
              <div className="mb-3.5 flex items-center gap-3 border-b border-slate-200 pb-3">
                <Avatar initials="PS" grad="linear-gradient(135deg,#7c5cff,#a78bfa)" />
                <div>
                  <div className="text-[15px] font-bold">Priya Sharma</div>
                  <div className="text-xs text-slate-500">Luxury cruise concierge</div>
                </div>
                <span className="ml-auto rounded-full border border-[#c2f0f3] bg-[#e7fbfc] px-2.5 py-1 text-[11px] font-semibold text-[#0891a6]">
                  AI-assisted chat
                </span>
              </div>
              <div className="mb-2.5 max-w-[86%] rounded-2xl rounded-bl-sm bg-[#eef3fb] px-3.5 py-2.5 text-sm">
                {"We want a luxury Mediterranean cruise for our 25th anniversary — somewhere with a quiet, adults-only feel."}
              </div>
              <div className="mb-2.5 ml-auto max-w-[86%] rounded-2xl rounded-br-sm px-3.5 py-2.5 text-sm text-white" style={{ background: "linear-gradient(135deg,#1565d8,#4f8df9)" }}>
                {"A milestone like that deserves something special. For an intimate, refined Mediterranean sailing I would look at a ship-within-a-ship suite — a private sundeck and a dedicated concierge."}
                <span className="mt-2 block rounded-xl bg-white/15 px-2.5 py-2 text-[13px]">
                  {"I found 3 sailings that match. Want a side-by-side quote with suite options and anniversary perks?"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#4f8df9]" />
                {"generating quote — pulling live host inventory…"}
              </div>
            </div>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20" style={{ background: "linear-gradient(to bottom, transparent, #f6f9fd)" }} />
      </header>

      <div className="border-b border-slate-200 bg-white py-7">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-center gap-10 px-6">
          <span className="text-[13px] font-semibold text-slate-500">Works alongside the host agencies you already book with</span>
          {["Travel Leaders", "Avoya", "Cruise Planners", "+ your host"].map((h) => (
            <span key={h} className="text-[17px] font-extrabold text-slate-400">{h}</span>
          ))}
        </div>
      </div>

      <section className="py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>Why agents switch</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Built for the way independent agents actually work</h2>
          <p className="mx-auto max-w-[620px] text-lg text-slate-500">
            {"You do not want a new host agency. You want to sell more cruises in less time. That is the whole product."}
          </p>
          <div className="mt-11 grid gap-5 text-left md:grid-cols-3">
            <ValueCard
              bg="#e7f0ff"
              title="Your commissions stay yours"
              text="You bring your own host-agency credentials. Bookings and commissions flow through your existing host exactly as they do today — we never sit in the middle of your money."
              icon={<path d="M12 2l2.5 6.5L21 9l-5 4 1.8 7L12 16l-5.8 4L8 13 3 9l6.5-.5L12 2z" fill="#1565d8" />}
            />
            <ValueCard
              bg="#e7fbfc"
              title="Six AI cruise specialists"
              text="Not a generic chatbot — six distinct cruise experts, each with a real specialty from Caribbean to luxury to accessible travel, answering clients in your voice around the clock."
              icon={<><circle cx="12" cy="8" r="4" fill="#06b6c4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" stroke="#06b6c4" strokeWidth="2.2" fill="none" strokeLinecap="round" /></>}
            />
            <ValueCard
              bg="#fff1ec"
              title="Quote in seconds, not hours"
              text="The AI pulls live host inventory, builds a side-by-side quote, drafts the client email, and logs it all to your CRM — while you are still on your next call."
              icon={<><rect x="3" y="4" width="18" height="16" rx="3" fill="#ff5a3c" /><path d="M7 9h10M7 13h7" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></>}
            />
          </div>
        </div>
      </section>

      <section id="how" className="border-y border-slate-200 bg-white py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Live in an afternoon</h2>
          <p className="mx-auto max-w-[620px] text-lg text-slate-500">No migration project, no IT team. Connect what you already have and start selling.</p>
          <div className="mt-12 grid gap-6 text-left md:grid-cols-3">
            {[
              { n: "1", title: "Connect your host", text: "Add the host-agency credentials you already use. Your bookings keep flowing through them — nothing about your commission relationship changes." },
              { n: "2", title: "Meet your AI crew", text: "Six cruise specialists are ready out of the box. On Pro and Agency you can rename them to fit your brand; on Agency you can fine-tune how they speak." },
              { n: "3", title: "Sell on your domain", text: "Share your client chat link. On the Agency tier it runs on your own custom domain and sends from your own email — fully white-labeled." },
            ].map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-slate-200 bg-white px-6 py-7">
                <div className="absolute -top-4 left-6 grid h-9 w-9 place-items-center rounded-xl bg-[#0a2540] font-extrabold text-white">{s.n}</div>
                <h3 className="mb-2 mt-3.5 text-lg font-bold">{s.title}</h3>
                <p className="text-[15px] text-slate-500">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="py-20">
        <div className="mx-auto max-w-[1140px] px-6">
          <div className="mb-5 text-center">
            <Eyebrow>Inside the platform</Eyebrow>
            <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">A complete cruise-selling workspace</h2>
          </div>

          <div className="grid items-center gap-12 md:grid-cols-2">
            <div>
              <h3 className="text-2xl font-bold md:text-[28px]">A CRM that fills itself in</h3>
              <p className="mt-3 text-lg text-slate-500">
                {"Every chat, quote, and email is captured against the client automatically. The AI remembers preferences and past sailings, so the next conversation starts warm — not from scratch."}
              </p>
              <FeatureList items={[
                "Contacts, lead status, and history in one place",
                "AI remembers cabin preferences, anniversaries, past cruise lines",
                "Every AI quote and email logged to the client record",
                "Included on every tier — even Research",
              ]} />
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_rgba(10,37,64,0.18)]">
              <MockBar url="yourname.ai-travelconcierge.com/crm" />
              <div className="p-3.5">
                <div className="grid grid-cols-[1.4fr_1fr_0.8fr] gap-2 rounded-t-lg bg-[#f4f7fc] px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  <div>Client</div><div>Interest</div><div>Status</div>
                </div>
                {[
                  { i: "JM", g: "#1565d8", n: "Janet & Mike R.", t: "Alaska, July", s: "Hot lead", c: "bg-[#ffe7e1] text-[#ec4326]" },
                  { i: "DL", g: "#06b6c4", n: "Diane L.", t: "Mediterranean luxury", s: "Quoted", c: "bg-[#fff3d6] text-[#b7791f]" },
                  { i: "TF", g: "#7c5cff", n: "The Foster family", t: "Caribbean, spring", s: "Booked", c: "bg-[#e6f7ef] text-emerald-600" },
                  { i: "RG", g: "#ff8a4c", n: "Robert G.", t: "River cruise, fall", s: "Quoted", c: "bg-[#fff3d6] text-[#b7791f]" },
                ].map((row) => (
                  <div key={row.i} className="grid grid-cols-[1.4fr_1fr_0.8fr] items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-[13px]">
                    <div className="flex items-center gap-2.5"><Avatar initials={row.i} grad={row.g} size={28} /> {row.n}</div>
                    <div className="text-slate-500">{row.t}</div>
                    <div><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${row.c}`}>{row.s}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-20 grid items-center gap-12 md:grid-cols-2">
            <div className="md:order-2">
              <h3 className="text-2xl font-bold md:text-[28px]">Quotes your clients can say yes to</h3>
              <p className="mt-3 text-lg text-slate-500">
                {"Ask the AI for options and it returns a clean, branded, side-by-side quote — pulled from your host inventory — ready to send."}
              </p>
              <FeatureList items={[
                "Live host inventory, not stale spreadsheets",
                "Cabin tiers, taxes, and perks itemized automatically",
                "One click turns a quote into a drafted client email",
                "Group bookings on Pro and Agency",
              ]} />
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_rgba(10,37,64,0.18)] md:order-1">
              <MockBar url="Quote · Diane L." />
              <div className="p-[18px]">
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="px-[18px] py-4 text-white" style={{ background: "linear-gradient(135deg,#0a2540,#14406e)" }}>
                    <div className="text-base font-extrabold">7-Night Western Mediterranean</div>
                    <div className="text-xs text-[#bcd3ef]">Yacht Club Suite · Barcelona round-trip · Oct 12</div>
                  </div>
                  <div className="flex justify-between border-b border-slate-200 px-[18px] py-2.5 text-sm"><span>Suite (2 guests)</span><span>$4,180</span></div>
                  <div className="flex justify-between border-b border-slate-200 px-[18px] py-2.5 text-sm"><span>Taxes & port fees</span><span>$398</span></div>
                  <div className="flex justify-between border-b border-slate-200 px-[18px] py-2.5 text-sm text-slate-500"><span>Anniversary perk — specialty dining</span><span>included</span></div>
                  <div className="flex justify-between bg-[#f7faff] px-[18px] py-2.5 text-base font-extrabold"><span>Total</span><span>$4,578</span></div>
                </div>
                <div className="mt-3 flex gap-2.5">
                  <span className="flex-1 rounded-full bg-[#0a2540] py-2.5 text-center text-sm font-bold text-white">Draft email</span>
                  <span className="flex-1 rounded-full bg-[#eef3fb] py-2.5 text-center text-sm font-bold text-[#1565d8]">Save to CRM</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="personas" className="border-t border-slate-200 bg-white py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>Meet your AI crew</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Six cruise specialists, ready on day one</h2>
          <p className="mx-auto max-w-[640px] text-lg text-slate-500">
            {"Each persona has a real area of expertise, and clients are routed to the right specialist automatically. Available on every tier — rename them on Pro, fine-tune their voice on Agency."}
          </p>
          <div className="mt-11 grid gap-5 text-left sm:grid-cols-2 lg:grid-cols-3">
            {personas.map((p) => (
              <div key={p.name} className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-[22px] shadow-sm">
                <Avatar initials={p.initials} grad={p.grad} size={52} />
                <div>
                  <h3 className="text-[17px] font-bold">{p.name}</h3>
                  <div className="my-1.5 text-[13px] font-semibold text-[#0891a6]">{p.specialty}</div>
                  <p className="text-sm text-slate-500">{p.blurb}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-[1140px] px-6">
          <div className="text-center">
            <Eyebrow>Client-ready, in your voice</Eyebrow>
            <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Pre-cruise emails the AI sends for you</h2>
            <p className="mx-auto max-w-[640px] text-lg text-slate-500">
              {"Content-rich touchpoints at 90, 7, and 1 days out — drafted, scheduled, and logged automatically. Here is a real sequence for a Norwegian Bliss sailing round-trip from Seattle to Alaska."}
            </p>
          </div>

          <div className="mx-auto mt-9 flex max-w-[560px] items-center justify-between">
            {emails.map((e, idx) => (
              <div key={e.badge} className="flex flex-1 items-center">
                <div className="flex flex-col items-center">
                  <span className="grid h-11 w-11 place-items-center rounded-full text-white" style={{ background: "linear-gradient(135deg,#1565d8,#06b6c4)" }}>
                    <b className="text-[13px]">{e.badge.split(" ")[0]}</b>
                  </span>
                  <span className="mt-1.5 text-[11px] font-semibold text-slate-500">days out</span>
                </div>
                {idx < emails.length - 1 && <span className="mx-1 h-0.5 flex-1 bg-slate-200" />}
              </div>
            ))}
          </div>

          <div className="mt-8 grid gap-7 md:grid-cols-3">
            {emails.map((e) => (
              <div key={e.badge} className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 bg-[#fbfdff] px-5 py-4">
                  <div className="flex items-center justify-between">
                    <span className="rounded-full bg-[#e7f0ff] px-2.5 py-1 text-[11px] font-bold text-[#1565d8]">{e.badge}</span>
                    <span className="text-[11px] text-slate-400">{e.date}</span>
                  </div>
                  <div className="mt-2.5 text-[15px] font-bold leading-snug">{e.subject}</div>
                  <div className="mt-1 text-xs text-slate-500">From: you@youragency.com · {e.to}</div>
                </div>
                <div className="flex flex-1 flex-col px-5 py-4 text-[13.5px] text-[#2c3a4f]">
                  <span className="mb-3 inline-block w-fit rounded-full border border-[#c2f0f3] bg-[#e7fbfc] px-2.5 py-1 text-[11px] font-bold text-[#0891a6]">{e.tag}</span>
                  <p className="mb-3">{e.lead}</p>
                  <ul className="mb-3 space-y-2">
                    {e.bullets.map((b) => (
                      <li key={b.label} className="leading-snug">
                        <b className="text-[#16243a]">{b.label}</b> — {b.text}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-auto text-slate-500">{e.close}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="border-y border-slate-200 bg-white py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Simple plans. 30-day free trial on all of them.</h2>
          <p className="mx-auto max-w-[620px] text-lg text-slate-500">Bring your own host agency on every tier. No setup fees. Cancel anytime during your trial.</p>
          <AgencyPricing />
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>Compare tiers</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Exactly what is in each plan</h2>
          <div className="mt-11 overflow-x-auto text-left">
            <table className="w-full min-w-[560px] overflow-hidden rounded-2xl bg-white shadow-sm">
              <thead>
                <tr className="bg-[#0a2540] text-white">
                  <th className="px-[18px] py-3.5 text-left text-sm font-bold">Feature</th>
                  <th className="px-[18px] py-3.5 text-sm font-bold">Research</th>
                  <th className="px-[18px] py-3.5 text-sm font-bold">Professional</th>
                  <th className="px-[18px] py-3.5 text-sm font-bold">Agency</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.feature} className="border-b border-slate-100 hover:bg-[#f9fbfe]">
                    <td className="bg-[#1565d8]/5 px-[18px] py-3.5 text-left text-sm font-semibold">{row.feature}</td>
                    <Cell on={row.r} /><Cell on={row.p} /><Cell on={row.a} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Multi-stop linear gradient — not expressible as static Tailwind */}
      <section className="text-white" style={{ background: TRUST_BG }}>
        <div className="mx-auto max-w-[1140px] px-6 py-20 text-center">
          <Eyebrow light>AI you can put in front of clients</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Every AI reply is checked before it sends</h2>
          <p className="mx-auto max-w-[640px] text-lg text-[#bcd0ea]">
            {"An automated supervisor reviews each response for accuracy, tone, and compliance — so the AI sounds like a seasoned agent, not a risky chatbot. Clients always see a clear AI-assisted disclosure."}
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            {supervisorChecks.map((c) => (
              <div key={c} className="flex items-center gap-2.5 rounded-xl border border-white/20 bg-white/10 px-[18px] py-3.5 text-sm font-semibold">
                <span className="h-2.5 w-2.5 rounded-full bg-[#4be0a0] shadow-[0_0_0_4px_rgba(75,224,160,0.18)]" /> {c}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="faq" className="py-20">
        <div className="mx-auto max-w-[1140px] px-6 text-center">
          <Eyebrow>Questions</Eyebrow>
          <h2 className="mb-2 mt-2.5 text-[28px] font-bold md:text-[40px]">Things agents ask us first</h2>
          <div className="mx-auto mt-10 max-w-[800px] text-left">
            {faqs.map((f) => (
              <details key={f.q} className="group mb-3 rounded-xl border border-slate-200 bg-white px-5 shadow-sm">
                <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-base font-bold [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="text-2xl font-normal text-[#1565d8] group-open:hidden">+</span>
                  <span className="hidden text-2xl font-normal text-[#1565d8] group-open:inline">−</span>
                </summary>
                <p className="pb-4 text-[15px] text-slate-500">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Radial+linear gradient combo — not expressible as static Tailwind */}
      <div className="mx-auto mb-20 max-w-[1140px] rounded-[26px] px-7 py-16 text-center text-white" style={{ background: FINAL_BG }}>
        <h2 className="text-[28px] font-bold md:text-[44px]">Start selling more cruises this week</h2>
        <p className="mx-auto mt-3.5 max-w-[560px] text-lg opacity-95">
          {"Keep your host. Keep your commissions. Add an AI crew that quotes, remembers, and follows up for you — free for 30 days."}
        </p>
        <div className="mt-7">
          <Link href="/signup" className="inline-flex items-center justify-center rounded-full bg-white px-9 py-4 text-lg font-bold text-[#ec4326] shadow-[0_14px_30px_rgba(0,0,0,0.25)] transition-transform hover:-translate-y-0.5">
            Start your free trial
          </Link>
        </div>
        <div className="mt-4 text-sm opacity-90">No charge during your trial · No setup fees · Cancel anytime</div>
      </div>

      <footer className="bg-[#0a2540] py-14 text-[#aebfd6]">
        <div className="mx-auto max-w-[1140px] px-6">
          <div className="flex flex-wrap justify-between gap-10">
            <div className="max-w-[320px]">
              <div className="mb-3 flex items-center gap-2.5 text-lg font-extrabold text-white">
                <BrandMark />
                AI Travel Concierge
              </div>
              <p className="text-sm">The AI + software layer for independent cruise agents. Bring your own host agency.</p>
            </div>
            <div className="flex flex-wrap gap-14">
              <div>
                <h4 className="mb-3.5 text-sm font-bold uppercase tracking-wider text-white">Product</h4>
                {[["Features", "#features"], ["AI crew", "#personas"], ["Pricing", "#pricing"], ["FAQ", "#faq"]].map(([t, h]) => (
                  <a key={t} href={h} className="mb-2.5 block text-sm hover:text-white">{t}</a>
                ))}
              </div>
              <div>
                <h4 className="mb-3.5 text-sm font-bold uppercase tracking-wider text-white">Get started</h4>
                <Link href="/signup" className="mb-2.5 block text-sm hover:text-white">Start free trial</Link>
              </div>
            </div>
          </div>
          <div className="mt-10 flex flex-wrap justify-between gap-5 border-t border-white/10 pt-6 text-[13px]">
            <span>© 2026 AI Travel Concierge</span>
            <span className="max-w-[640px] leading-relaxed">
              {"Conversations handled by our AI personas are clearly disclosed as AI-assisted. Screenshots and sample emails on this page are illustrative. Pricing shown for bring-your-own-host-agency plans."}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function BrandMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect width="48" height="48" rx="12" fill="#0a2540" />
      <path d="M9 30c3 2.4 5.2 2.4 8 0 2.8-2.4 5.2-2.4 8 0 2.8 2.4 5.2 2.4 8 0 2.2-1.9 4-2.3 6-1.2" stroke="#06b6c4" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M24 9l9 5.5v8L24 28l-9-5.5v-8L24 9z" fill="#4f8df9" />
      <circle cx="24" cy="18.5" r="3" fill="#fff" />
    </svg>
  );
}

function ValueCard({ bg, title, text, icon }: { bg: string; title: string; text: string; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl" style={{ background: bg }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">{icon}</svg>
      </div>
      <h3 className="mb-2 text-[19px] font-bold">{title}</h3>
      <p className="text-[15px] text-slate-500">{text}</p>
    </div>
  );
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-[18px] space-y-3">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-2.5 text-[15px]">
          <span className="mt-0.5 grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-[#e6f7ef] text-[13px] font-extrabold text-emerald-600" aria-hidden>✓</span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Cell({ on }: { on: boolean }) {
  return (
    <td className="px-[18px] py-3.5 text-center text-sm">
      {on ? <span className="font-extrabold text-emerald-600">✓</span> : <span className="text-slate-300">—</span>}
    </td>
  );
}
