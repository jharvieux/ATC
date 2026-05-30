/**
 * Render sample customer-facing emails for visual review.
 *
 * Renders the pre-cruise series (T-90 / T-30 / T-7 / T-1) plus the two
 * group-cruise touchpoints (GroupInvitation / GroupBroadcast) using
 * realistic NCL Bliss Western Caribbean sample data.
 *
 * T-1 calls Open-Meteo directly for live Miami weather, bypassing the
 * DB-backed cache + rate-limit gate from `lib/weather/open-meteo.ts`.
 * Those exist for production use; the sample renderer doesn't need them
 * and shouldn't pollute the cache table.
 *
 * Run:
 *   pnpm tsx scripts/render-email-samples.tsx
 *
 * Output:
 *   /tmp/sample-precruise-t{90,30,7,1}.html  (4 files)
 *   /tmp/sample-group-{invitation,broadcast}.html  (2 files)
 *
 * Iterating on a single email: comment out the writeFileSync calls you
 * don't need, edit the props, re-run. Or just clone the script and edit
 * a copy under /tmp/.
 *
 * Replacing the sample data with real-tenant data: swap SAMPLE_LAYOUT
 * (tenant branding) and the persona/scenario constants near the top.
 * No DB or auth required.
 *
 * See docs/runbooks/email-samples.md for the operator-facing workflow.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as fs from "node:fs";

import { PreCruiseT90 } from "../apps/main/src/emails/PreCruiseT90";
import { PreCruiseT30 } from "../apps/main/src/emails/PreCruiseT30";
import { PreCruiseT7 } from "../apps/main/src/emails/PreCruiseT7";
import { PreCruiseT1, type PortInfo } from "../apps/main/src/emails/PreCruiseT1";
import { GroupInvitation } from "../apps/main/src/emails/GroupInvitation";
import { GroupBroadcast } from "../apps/main/src/emails/GroupBroadcast";
import { wmoCodeToText } from "../apps/main/src/lib/weather/wmo-codes";

// ── Sample tenant + customer + cruise ────────────────────────────────────────

const SAMPLE_LAYOUT = {
  branding: {
    primary_color: "#003B6F",      // NCL navy
    accent_color: "#F5A623",       // sunset orange
    slogan: "Voyages curated for you",
  },
  tenant_legal_name: "Anchor & Compass Travel, LLC",
  tenant_business_address: "742 Harbor View Drive, Suite 200, Miami, FL 33131",
  unsubscribe_url: "https://anchorcompass.example.com/u/abc123",
};

const SAILING_DATE = "August 28, 2026"; // 90 days from 2026-05-30
const SHIP = "Norwegian Bliss";
const CRUISE_LINE = "Norwegian Cruise Line";
const CUSTOMER = "Jordan";

// Embarkation port + lat/lon for the live Open-Meteo call.
const MIAMI_LAT = 25.7617;
const MIAMI_LON = -80.1918;

const COMPANION_PAGE = "https://anchorcompass.example.com/c/sample-token";

// ── Live weather call (T-1 only) ──────────────────────────────────────────────

interface WeatherSummary {
  high_f: number;
  low_f: number;
  precipitation_in: number;
  conditions: string;
}

async function fetchMiamiWeather(): Promise<WeatherSummary | null> {
  // For the sample, pull a forecast within Open-Meteo's 16-day window.
  const target = new Date();
  target.setUTCDate(target.getUTCDate() + 7);
  const dateStr = target.toISOString().slice(0, 10);

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(MIAMI_LAT));
  url.searchParams.set("longitude", String(MIAMI_LON));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", dateStr);
  url.searchParams.set("end_date", dateStr);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const body = (await res.json()) as {
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        weathercode?: number[];
      };
    };
    const high = body.daily?.temperature_2m_max?.[0];
    const low = body.daily?.temperature_2m_min?.[0];
    const precip = body.daily?.precipitation_sum?.[0];
    const code = body.daily?.weathercode?.[0];
    if (high == null || low == null || precip == null || code == null) return null;
    return {
      high_f: Math.round(high),
      low_f: Math.round(low),
      precipitation_in: Math.round(precip * 100) / 100,
      conditions: wmoCodeToText(code),
    };
  } catch {
    return null;
  }
}

function renderWeatherSummary(w: WeatherSummary | null): string | null {
  if (!w) return null;
  const precipNote =
    w.precipitation_in > 0.05
      ? ` Pack a light rain layer — about ${w.precipitation_in.toFixed(2)}" of rain expected.`
      : " Skies look dry — sunscreen and a hat are your friends.";
  return (
    `Miami forecast for embarkation: ${w.conditions.toLowerCase()}, ` +
    `high ${w.high_f}°F / low ${w.low_f}°F.${precipNote}`
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const weather = await fetchMiamiWeather();
  if (!weather) {
    console.warn("[samples] Open-Meteo fetch failed; T-1 sample will omit weather section.");
  } else {
    console.log(
      `[samples] Miami forecast: ${weather.conditions}, ${weather.low_f}°F / ${weather.high_f}°F, ${weather.precipitation_in}" precip`,
    );
  }

  const t90Html = renderToStaticMarkup(
    React.createElement(PreCruiseT90, {
      layout: SAMPLE_LAYOUT,
      customer_name: CUSTOMER,
      ship_name: SHIP,
      cruise_line: CRUISE_LINE,
      sailing_date: SAILING_DATE,
      ports: ["Miami, FL", "Roatán, Honduras", "Harvest Caye, Belize", "Costa Maya, Mexico", "Cozumel, Mexico"],
      documentation_reminder:
        "Quick check — is your passport valid through February 2027? Most cruise lines require six months of validity past your return date. If you're renewing, allow 10–13 weeks for routine processing.",
      destination_teaser:
        "Western Caribbean in late August: warm turquoise water, swaying palms, and that exhale-into-your-lounger feeling. Roatán's Mahogany Bay is a stand-out — its coral reefs are among the healthiest in the western hemisphere, and the on-island lazy river is a guilty pleasure even seasoned cruisers come back for.",
      must_do_experiences: [
        "Snorkel the Mesoamerican Barrier Reef at Roatán — second-largest in the world, and visible from the surface even without flippers.",
        "Walk the Mayan ruins of San Gervasio on Cozumel — small site, big stories, no crowds.",
        "Climb the lighthouse at Costa Maya for a sunset shot you'll send to everyone you know.",
      ],
      did_you_know:
        "Norwegian Bliss carries the cruise industry's first race track at sea — and yes, it goes around two decks of corkscrew turns. Lap times get oddly competitive by day four.",
      suggested_reads: [
        "The Lost City of the Monkey God — Douglas Preston (Honduras)",
        "The Sound of Things Falling — Juan Gabriel Vásquez (Caribbean atmosphere)",
        "Cousteau's Caribbean — documentary on Disney+",
      ],
    }),
  );

  const t30Html = renderToStaticMarkup(
    React.createElement(PreCruiseT30, {
      layout: SAMPLE_LAYOUT,
      customer_name: CUSTOMER,
      ship_name: SHIP,
      sailing_date: SAILING_DATE,
      reservation_reminders: [
        "Book Cagney's Steakhouse for embarkation night — they sell out 2 weeks before sailing.",
        "Reserve the Mandara Spa Thermal Suite pass for at-sea days (about $40/day vs $60 onboard).",
        "Snag your Roatán excursion now — the Tabyana Beach + reef snorkel combo books out fast.",
      ],
      checkin_window:
        "Online check-in opens 21 days before sailing — that's August 7. The earlier you grab your boarding time slot, the smoother embarkation morning.",
      final_payment_note:
        "Friendly reminder: final payment was due on May 30. If you've already settled it, you're good — skip this section. If anything's outstanding, ping us and we'll sort it.",
      personalized_recommendations: [
        "Based on your prior bookings, the Vibe Beach Club day pass would suit you — adults-only, smaller crowd, complimentary drinks.",
        "You enjoyed the Italian dining on your Med cruise — La Cucina on Bliss is the same family.",
      ],
      specialty_experiences: [
        "The Cellars by Michael Mondavi wine pairing dinner (Tue night sailings).",
        "Beatles Cover Band at Cavern Club — most nights, free, surprisingly good.",
      ],
      pack_inspiration:
        "Daytime is shorts-and-quick-dry weather; nights aboard get cool from the AC, so a light cardigan or pullover earns its luggage space. Two pairs of shoes do it: walking sneakers for ports, sandals for everything else.",
      companion_page_url: COMPANION_PAGE,
    }),
  );

  const t7Html = renderToStaticMarkup(
    React.createElement(PreCruiseT7, {
      layout: SAMPLE_LAYOUT,
      customer_name: CUSTOMER,
      ship_name: SHIP,
      sailing_date: SAILING_DATE,
      packing_checklist: [
        "Passport (valid through Feb 2027) + 2 photocopies in separate bags",
        "Boarding pass printed AND on your phone",
        "Reef-safe sunscreen (Hawaii/Mexico/Belize regs — no oxybenzone/octinoxate)",
        "Bug spray with picaridin (Roatán has no-see-ums at dusk)",
        "Quick-dry swimsuit + cover-up + a second swimsuit for back-to-back beach days",
        "Light cardigan or pullover (the ship's AC runs cold)",
        "Reusable water bottle (refill stations are everywhere onboard)",
        "Portable charger (cabin outlets are limited)",
        "Magnetic hooks for cabin walls (ship walls are steel — game-changer for organizing)",
        "Any prescription meds in carry-on — never check them",
      ],
      ship_highlights: [
        "Aqua Park: two-deck waterslide complex, includes the Aqua Loop (vertical drop loop)",
        "The Local Bar & Grill (24-hour casual dining, no surcharge)",
        "Observation Lounge on Deck 15 — best at-sea-day reading spot, panoramic windows",
      ],
      cruise_line_tips: [
        "NCL's Freestyle Dining means no fixed seating — but specialty restaurants still need reservations.",
        "The crew change pier-side on Saturday morning. Embarkation traffic is heaviest 11am–1pm; aim for 1:30pm if you want a faster line.",
        "Drinks package activates when you scan your card — keep your room key with you everywhere.",
      ],
      embarkation_advice:
        "PortMiami Terminal B. Arrive between 1pm and 2pm if you booked the standard window. Park in the cruise garage ($22/day) or drop off curbside and let the driver park elsewhere. Bring patience — embarkation day is its own adventure.",
      first_day_inspiration:
        "Drop your carry-on, head straight to the Local for lunch (cabins aren't ready until 2:30pm anyway), then walk the ship deck-by-deck. By dinner you'll know where everything is. The first-night vibe at sail-away — top deck, drink in hand, Miami skyline fading — is the moment you remember when you book your next one.",
      companion_page_url: COMPANION_PAGE,
    }),
  );

  const t1Html = renderToStaticMarkup(
    React.createElement(PreCruiseT1, {
      layout: SAMPLE_LAYOUT,
      customer_name: CUSTOMER,
      ship_name: SHIP,
      departure_port: {
        port_name: "PortMiami, FL",
        official_url: "https://www.miamidade.gov/portmiami/",
        terminal_addresses: [
          { terminal: "Terminal B (NCL)", address: "1015 N Cruise Blvd, Miami, FL 33132" },
        ],
        parking_info: "Cruise Parking Garage on-site: $22/day. Pre-payment available via the PortMiami app.",
        transit_dropoff_info:
          "Uber/Lyft drop-off zone is on the east side of Terminal B. Allow 20 min from the airport in mid-morning, 35+ in afternoon.",
        arrival_advice:
          "Your boarding time is 1:00pm–1:30pm. Earlier arrivals will wait outside; later than 2:30pm risks missing all-aboard.",
      } as PortInfo,
      first_port_preview:
        "Tomorrow night you're at sea heading south. First port is Roatán on Day 3. Once you're aboard, the Cruise Director's daily program lands in your cabin — that has the disembarkation time and shuttle details for the Mahogany Bay excursion you booked.",
      day_of_expectations:
        "Check-in at Terminal B → security → onboard photo → drop your carry-on at your cabin (or with the porter if cabins aren't ready) → muster drill notification arrives in your cabin TV or app, complete it before sail-away → top deck for the sail-away party.",
      weather_summary: renderWeatherSummary(weather),
      companion_page_url: COMPANION_PAGE,
    }),
  );

  const wrap = (title: string, html: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{margin:0;background:#f3f4f6;padding:20px;font-family:system-ui,sans-serif;}` +
    `.sample-frame{max-width:680px;margin:0 auto;background:white;box-shadow:0 1px 3px rgba(0,0,0,0.1);}</style>` +
    `</head><body><div class="sample-frame">${html}</div></body></html>`;

  // ── Group cruise samples ────────────────────────────────────────────────────
  //
  // Scenario: "Patel-Khan Wedding Voyage" — a destination-wedding group cruise
  // on the same NCL Bliss Western Caribbean itinerary, coordinated by the
  // bride's mother through Anchor & Compass Travel. Two emails:
  //
  //   1. GroupInvitation — sent to a cousin who hasn't booked yet; includes
  //      cabin-grid summary (anonymized counts per §18.6), invite link, and
  //      target group rate.
  //   2. GroupBroadcast — sent later by the coordinator to all booked guests
  //      with a logistics update (final payment reminder + group-photo time).

  const GROUP_BRANDING = SAMPLE_LAYOUT.branding;
  const GROUP_TENANT_BRANDING = {
    branding: GROUP_BRANDING,
    tenant_legal_name: SAMPLE_LAYOUT.tenant_legal_name,
    tenant_business_address: SAMPLE_LAYOUT.tenant_business_address,
    unsubscribe_url: "https://anchorcompass.example.com/u/group-abc456",
  };

  const groupInvitationHtml = renderToStaticMarkup(
    React.createElement(GroupInvitation, {
      ...GROUP_TENANT_BRANDING,
      invitee_name: "Priya",
      cruise_line: CRUISE_LINE,
      ship_name: SHIP,
      sailing_date: SAILING_DATE,
      departure_port: "PortMiami, FL",
      coordinator_message:
        "Priya! Mom & I would love for you and Kunal to celebrate with us at sea. We've blocked a group of cabins on the Bliss — most of the family is doing the Roatán snorkel together on Day 3, and we'll have a private reception on the Observation Deck the night before our vow renewal in Cozumel. RSVP by July 15 to lock the group rate.",
      hero_image_url: null,
      booked_count: 18,
      interested_count: 6,
      invite_url: "https://anchorcompass.example.com/g/patel-khan-2026/invite/priya-abc",
      target_group_rate_formatted: "$1,899 per person (inside cabin, double occupancy)",
    }),
  );

  const groupBroadcastHtml = renderToStaticMarkup(
    React.createElement(GroupBroadcast, {
      ...GROUP_TENANT_BRANDING,
      subject: "Final payment reminder + group photo logistics",
      group_name: "Patel-Khan Wedding Voyage",
      message:
        "Hi everyone! Three quick logistics things as we get close to sailing.\n\n" +
        "Final payment is due to NCL by Friday, July 31. If you booked through Anchor & Compass we've already handled that on your behalf — you'll see the charge on your card. If you booked direct, log into your NCL account and confirm payment cleared.\n\n" +
        "Group photo on Day 2 (the first sea day): meet at the Atrium grand staircase at 4:30pm. Dress code is \"resort cocktail\" — think linen, light colors, no flip-flops in the photo please! The photographer needs ~30 minutes; we'll head straight to Cagney's for the family dinner after.\n\n" +
        "For the Roatán excursion on Day 3: the meeting point is the Pearl Theatre at 7:45am. Reef-safe sunscreen only (the Tabyana Beach reef is protected), wear water shoes if you have them, and bring a credit card for the lunch buffet (it's about $18/person, not included).\n\n" +
        "Can't wait to celebrate with you all!\n\nLove,\nAnjali",
    }),
  );

  fs.writeFileSync("/tmp/sample-precruise-t90.html", wrap("Pre-cruise T-90 sample", t90Html));
  fs.writeFileSync("/tmp/sample-precruise-t30.html", wrap("Pre-cruise T-30 sample", t30Html));
  fs.writeFileSync("/tmp/sample-precruise-t7.html",  wrap("Pre-cruise T-7 sample",  t7Html));
  fs.writeFileSync("/tmp/sample-precruise-t1.html",  wrap("Pre-cruise T-1 sample",  t1Html));
  fs.writeFileSync("/tmp/sample-group-invitation.html", wrap("Group invitation sample", groupInvitationHtml));
  fs.writeFileSync("/tmp/sample-group-broadcast.html",  wrap("Group broadcast sample",  groupBroadcastHtml));

  console.log("[samples] wrote /tmp/sample-precruise-t{90,30,7,1}.html");
  console.log("[samples] wrote /tmp/sample-group-{invitation,broadcast}.html");
}

void main();
