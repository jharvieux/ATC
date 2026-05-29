"use client";

import Link from "next/link";
import { useState } from "react";

type Tier = {
  name: string;
  blurb: string;
  monthly: string;
  annual: string;
  perMonthly: string;
  perAnnual: string;
  subMonthly: string;
  subAnnual: string;
  featured: boolean;
  features: { text: string; on: boolean }[];
};

const tiers: Tier[] = [
  {
    name: "Research",
    blurb: "For the solo agent exploring AI — chat, quotes, and CRM to test the waters.",
    monthly: "$19",
    annual: "$190",
    perMonthly: "/mo",
    perAnnual: "/yr",
    subMonthly: "1 seat · billed monthly",
    subAnnual: "1 seat · billed yearly (save $38)",
    featured: false,
    features: [
      { text: "AI chat with all 6 cruise specialists", on: true },
      { text: "Built-in CRM & client memory", on: true },
      { text: "Instant AI quotes from host inventory", on: true },
      { text: "Knowledge base (RAG) answers", on: true },
      { text: "Gmail import & group bookings", on: false },
      { text: "White-label custom domain", on: false },
    ],
  },
  {
    name: "Professional",
    blurb: "The full single-agent toolkit — everything you need to run your book of business.",
    monthly: "$59",
    annual: "$590",
    perMonthly: "/mo",
    perAnnual: "/yr",
    subMonthly: "1 seat · billed monthly",
    subAnnual: "1 seat · billed yearly (save $118)",
    featured: true,
    features: [
      { text: "Everything in Research, plus:", on: true },
      { text: "Group bookings & client forum chat", on: true },
      { text: "Gmail integration — import & reply", on: true },
      { text: "Supervisor quality dashboard", on: true },
      { text: "Rename your AI personas to your brand", on: true },
      { text: "Custom domain & white-label", on: false },
    ],
  },
  {
    name: "Agency",
    blurb: "For multi-agent shops that want a fully branded, white-label experience.",
    monthly: "$99",
    annual: "$990",
    perMonthly: "/mo base",
    perAnnual: "/yr base",
    subMonthly: "1 seat included · add seats below",
    subAnnual: "1 seat included · billed yearly (save $198)",
    featured: false,
    features: [
      { text: "Everything in Professional, plus:", on: true },
      { text: "Custom domain & custom email-from", on: true },
      { text: "Remove “Powered by” branding", on: true },
      { text: "Fine-tune persona voice & instructions", on: true },
      { text: "Add agents on a volume seat ladder", on: true },
      { text: "Multi-agent supervisor view", on: true },
    ],
  },
];

const ladder = [
  { seats: "Seat 1", costMonthly: "Included", costAnnual: "Included", perMonthly: "", perAnnual: "", highlight: true },
  { seats: "Seats 2–4", costMonthly: "$59", costAnnual: "$590", perMonthly: "/seat/mo", perAnnual: "/seat/yr", highlight: false },
  { seats: "Seats 5–10", costMonthly: "$49", costAnnual: "$490", perMonthly: "/seat/mo", perAnnual: "/seat/yr", highlight: false },
  { seats: "Seats 11+", costMonthly: "$39", costAnnual: "$390", perMonthly: "/seat/mo", perAnnual: "/seat/yr", highlight: false },
];

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full text-[11px] font-extrabold ${
        on ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-300"
      }`}
    >
      ✓
    </span>
  );
}

export function AgencyPricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <div>
      <div className="mx-auto mt-6 inline-flex rounded-full border border-slate-200 bg-white p-1.5 shadow-sm">
        <button
          type="button"
          onClick={() => setAnnual(false)}
          className={`rounded-full px-5 py-2.5 text-sm font-bold transition-colors ${
            annual ? "text-slate-500" : "bg-[#0a2540] text-white"
          }`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setAnnual(true)}
          className={`rounded-full px-5 py-2.5 text-sm font-bold transition-colors ${
            annual ? "bg-[#0a2540] text-white" : "text-slate-500"
          }`}
        >
          Annual <span className="font-bold text-emerald-600">2 months free</span>
        </button>
      </div>

      <div className="mx-auto mt-10 grid max-w-[420px] items-stretch gap-6 text-left md:max-w-none md:grid-cols-3">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`relative flex flex-col rounded-[18px] bg-white p-7 shadow-sm ${
              tier.featured
                ? "border-2 border-[#1565d8] shadow-[0_24px_50px_rgba(21,101,216,0.22)] md:-translate-y-1.5"
                : "border border-slate-200"
            }`}
          >
            {tier.featured && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#1565d8] px-3.5 py-1 text-xs font-bold text-white">
                Most popular
              </span>
            )}
            <h3 className="text-xl font-bold text-[#16243a]">{tier.name}</h3>
            <p className="mt-1 min-h-[40px] text-sm text-slate-500">{tier.blurb}</p>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-[44px] font-extrabold tracking-tight text-[#16243a]">
                {annual ? tier.annual : tier.monthly}
              </span>
              <span className="text-[15px] font-semibold text-slate-500">
                {annual ? tier.perAnnual : tier.perMonthly}
              </span>
            </div>
            <div className="min-h-[18px] text-[13px] text-slate-500">
              {annual ? tier.subAnnual : tier.subMonthly}
            </div>
            <ul className="my-6 space-y-3">
              {tier.features.map((f) => (
                <li
                  key={f.text}
                  className={`flex items-start gap-2 text-sm ${f.on ? "text-[#2c3a4f]" : "text-slate-400"}`}
                >
                  <Check on={f.on} />
                  <span>{f.text}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className={`mt-auto inline-flex w-full items-center justify-center rounded-full px-6 py-3.5 text-base font-bold transition-transform hover:-translate-y-0.5 ${
                tier.featured
                  ? "bg-[linear-gradient(135deg,#ff5a3c,#ec4326)] text-white shadow-[0_10px_24px_rgba(255,90,60,0.35)]"
                  : "bg-[#0a2540] text-white"
              }`}
            >
              Start free trial
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-7 text-left shadow-sm">
        <h3 className="text-lg font-bold text-[#16243a]">
          Agency seat pricing — the more agents, the lower the per-seat cost
        </h3>
        <p className="mt-1 mb-5 text-sm text-slate-500">
          Your first seat is included in the {annual ? "$990/yr" : "$99/mo"} base. Add agents at
          these {annual ? "annual" : "monthly"} rates (annual = 10× monthly — two months free):
        </p>
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          {ladder.map((rung) => {
            const cost = annual ? rung.costAnnual : rung.costMonthly;
            const per = annual ? rung.perAnnual : rung.perMonthly;
            return (
              <div
                key={rung.seats}
                className={`rounded-xl border border-slate-200 p-4 text-center ${
                  rung.highlight ? "bg-[#f7faff]" : ""
                }`}
              >
                <div className="text-[13px] font-bold text-slate-500">{rung.seats}</div>
                <div className="mt-1 text-[26px] font-extrabold text-[#16243a]">
                  {cost}
                  {per && <span className="text-[13px] font-semibold text-slate-500">{per}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 rounded-xl bg-[#f7faff] px-4 py-3.5 text-sm text-slate-500">
          Example — a <b className="text-[#16243a]">6-agent agency</b>: $99 base + 3 seats × $59 + 2
          seats × $49 = <b className="text-[#16243a]">$374/mo</b> (or{" "}
          <b className="text-[#16243a]">$3,740/yr</b>).
        </div>
      </div>
    </div>
  );
}
