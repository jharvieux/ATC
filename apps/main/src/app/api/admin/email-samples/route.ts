// #489 — Admin email sample preview + send.
//
// GET  /api/admin/email-samples?template=T1&... → HTML preview (Content-Type: text/html)
// POST /api/admin/email-samples                 → send via Resend, return { ok, resend_message_id }
//
// Both endpoints are gated by assertPlatformAdmin and wrapped in
// withPlatformAdminAudit so every send appears in audit_log.

import * as React from "react";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { sendEmail } from "@/lib/email/send";
import { PLATFORM_TENANT_SHIM, PLATFORM_BRANDING } from "@/lib/email/platform-tenant";
import { getDestinationImage, type DestinationRegion } from "@/lib/cruise-regions/destination-images";

import type { PreCruiseT90Props } from "@/emails/PreCruiseT90";
import type { PreCruiseT30Props } from "@/emails/PreCruiseT30";
import type { PreCruiseT7Props } from "@/emails/PreCruiseT7";
import type { PreCruiseT1Props } from "@/emails/PreCruiseT1";
import type { GroupInvitationProps } from "@/emails/GroupInvitation";
import type { GroupBroadcastProps } from "@/emails/GroupBroadcast";

const VALID_TEMPLATES = ["T90", "T30", "T7", "T1", "GroupInvitation", "GroupBroadcast"] as const;
type TemplateId = (typeof VALID_TEMPLATES)[number];

const PLATFORM_LAYOUT = {
  branding: PLATFORM_BRANDING,
  tenant_legal_name: PLATFORM_TENANT_SHIM.legal_name,
  tenant_business_address: PLATFORM_TENANT_SHIM.mailing_address,
  unsubscribe_url: "https://ai-travelconcierge.com/unsubscribe",
};

interface SampleParams {
  template: TemplateId;
  customer_name: string;
  ship_name: string;
  cruise_line: string;
  sailing_date: string;
  ports: string[];
  destination_region: DestinationRegion;
  companion_page_url: string;
  group_name: string | undefined;
  invitee_name: string | undefined;
  coordinator_message: string | undefined;
  invite_url: string | undefined;
  broadcast_subject: string | undefined;
  broadcast_message: string | undefined;
}

// Reads params through a getter rather than copying request entries into an
// object: nothing ever writes an attacker-controlled key to a property, so the
// prototype-pollution sink (CodeQL js/remote-property-injection) doesn't exist.
function parseSampleParams(get: (key: string) => string | undefined): SampleParams | { error: string } {
  const template = get("template") as TemplateId | undefined;
  if (!template || !VALID_TEMPLATES.includes(template)) {
    return { error: `Invalid template. Must be one of: ${VALID_TEMPLATES.join(", ")}` };
  }

  const portsRaw = get("ports") ?? "Miami\nAt sea\nRoatán\nHarvest Caye\nCosta Maya\nCozumel\nAt sea";
  const ports = portsRaw.split(/\n|,/).map((p) => p.trim()).filter(Boolean);

  return {
    template,
    customer_name: get("customer_name") || "Jordan",
    ship_name: get("ship_name") || "Norwegian Bliss",
    cruise_line: get("cruise_line") || "Norwegian Cruise Line",
    sailing_date: get("sailing_date") || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    ports,
    destination_region: (get("destination_region") as DestinationRegion | undefined) ?? "caribbean",
    companion_page_url: get("companion_page_url") || "https://example.com/companion",
    group_name: get("group_name"),
    invitee_name: get("invitee_name"),
    coordinator_message: get("coordinator_message"),
    invite_url: get("invite_url"),
    broadcast_subject: get("broadcast_subject"),
    broadcast_message: get("broadcast_message"),
  };
}

async function buildHtml(params: SampleParams): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const destImage = getDestinationImage(params.destination_region);

  let jsx: React.ReactElement;

  switch (params.template) {
    case "T90": {
      const { PreCruiseT90 } = await import("@/emails/PreCruiseT90");
      const props: PreCruiseT90Props = {
        layout: PLATFORM_LAYOUT,
        customer_name: params.customer_name,
        ship_name: params.ship_name,
        cruise_line: params.cruise_line,
        sailing_date: params.sailing_date,
        ports: params.ports,
        destination_image: destImage,
        documentation_reminder: "Make sure your passport is valid for at least 6 months beyond your return date. Check visa requirements for every port of call — even if you don't plan to go ashore.",
        destination_teaser: "Your Western Caribbean adventure is taking shape! From the turquoise waters of the Cayman Islands to the Mayan ruins of Mexico, your voyage promises memories that will last a lifetime.",
        must_do_experiences: ["Snorkeling at Stingray City in Grand Cayman", "Zip-lining through the jungle in Roatán", "Exploring Chichen Itza from Cozumel"],
        did_you_know: "The Caribbean is home to over 7,000 individual islands, islets, reefs, and cays — making it one of the most biodiverse marine environments on Earth.",
      };
      jsx = React.createElement(PreCruiseT90, props);
      break;
    }
    case "T30": {
      const { PreCruiseT30 } = await import("@/emails/PreCruiseT30");
      const props: PreCruiseT30Props = {
        layout: PLATFORM_LAYOUT,
        customer_name: params.customer_name,
        ship_name: params.ship_name,
        sailing_date: params.sailing_date,
        destination_image: destImage,
        reservation_reminders: ["Specialty dining reservations open 120 days before sailing — book now if you haven't already.", "Shore excursion booking closes 3 days before each port day.", "Complete your check-in on the cruise line app to receive your boarding pass."],
        checkin_window: "Online check-in is available 90–2 days before sailing. Complete it early to select your boarding time and avoid port delays.",
        final_payment_note: "If you booked on a payment plan, your final balance is due 90 days before departure.",
        personalized_recommendations: ["Book the Chef's Table dinner for a behind-the-scenes culinary experience.", "Reserve the Thermal Suite spa pass for daily access throughout your cruise."],
        pack_inspiration: "Think layers — Caribbean evenings can be breezy on deck. Bring a light jacket, reef-safe sunscreen, and comfortable walking shoes for shore days.",
        companion_page_url: params.companion_page_url,
      };
      jsx = React.createElement(PreCruiseT30, props);
      break;
    }
    case "T7": {
      const { PreCruiseT7 } = await import("@/emails/PreCruiseT7");
      const props: PreCruiseT7Props = {
        layout: PLATFORM_LAYOUT,
        customer_name: params.customer_name,
        ship_name: params.ship_name,
        sailing_date: params.sailing_date,
        destination_image: destImage,
        cruise_forecast: null,
        packing_checklist: ["Passport + printed boarding pass", "Reef-safe sunscreen SPF 50+", "Medications (carry-on only — never checked)", "Power strip / surge protector (no heating coils)", "Formal night outfit for sea days"],
        ship_highlights: [`${params.ship_name} features The Waterfront outdoor promenade — ideal for sunrise coffee`, "The Pool deck transforms into a full concert venue on sea nights", "The Observation Lounge on Deck 15 is the best spot for sailaway"],
        cruise_line_tips: [`${params.cruise_line} uses a cashless system on board — link a credit card at check-in`, "The Daily newsletter under your cabin door lists all activities for the next day", "Self-service laundry is available mid-ship on most cabin decks"],
        embarkation_advice: "Plan to arrive at the port 2.5–3 hours before departure. Complete online check-in, print your SetSail Pass, and have your sea pass luggage tags attached before you arrive.",
        first_day_inspiration: "The first evening at sea is magical — find a spot on the open deck for sailaway and watch the port recede into the horizon. The muster drill is required for all guests; it's quick and starts your adventure on the right note.",
        companion_page_url: params.companion_page_url,
      };
      jsx = React.createElement(PreCruiseT7, props);
      break;
    }
    case "T1": {
      const { PreCruiseT1 } = await import("@/emails/PreCruiseT1");
      const props: PreCruiseT1Props = {
        layout: PLATFORM_LAYOUT,
        customer_name: params.customer_name,
        ship_name: params.ship_name,
        departure_port: null,
        destination_image: destImage,
        first_port_preview: "Your first stop will greet you with warm Caribbean trade winds, vibrant local markets, and crystal-clear snorkeling straight off the beach.",
        day_of_expectations: "Embarkation typically takes 45–90 minutes from curb to cabin. Once aboard, head to the Lido deck buffet — it opens immediately and is a great way to start exploring the ship while your cabin is prepared.",
        cruise_forecast: null,
        weather_summary: "Expect warm, sunny weather throughout your voyage with highs in the mid-80s°F. Afternoon tropical showers are possible in port — brief and refreshing.",
        companion_page_url: params.companion_page_url,
      };
      jsx = React.createElement(PreCruiseT1, props);
      break;
    }
    case "GroupInvitation": {
      const { GroupInvitation } = await import("@/emails/GroupInvitation");
      const props: GroupInvitationProps = {
        branding: PLATFORM_BRANDING,
        tenant_legal_name: PLATFORM_TENANT_SHIM.legal_name,
        tenant_business_address: PLATFORM_TENANT_SHIM.mailing_address,
        unsubscribe_url: "https://ai-travelconcierge.com/unsubscribe",
        invitee_name: params.invitee_name ?? null,
        cruise_line: params.cruise_line,
        ship_name: params.ship_name,
        sailing_date: params.sailing_date,
        departure_port: params.ports[0] ?? "Miami, FL",
        coordinator_message: params.coordinator_message ?? "We are so excited to have you join us on this incredible voyage! This group cruise has been planned just for us — an adventure we'll talk about for years to come.",
        hero_image_url: destImage?.url ?? null,
        booked_count: 8,
        interested_count: 4,
        invite_url: params.invite_url ?? "https://example.com/group/invite/sample-token",
        target_group_rate_formatted: "$1,299 per person",
      };
      jsx = React.createElement(GroupInvitation, props);
      break;
    }
    case "GroupBroadcast": {
      const { GroupBroadcast } = await import("@/emails/GroupBroadcast");
      const props: GroupBroadcastProps = {
        branding: PLATFORM_BRANDING,
        tenant_legal_name: PLATFORM_TENANT_SHIM.legal_name,
        tenant_business_address: PLATFORM_TENANT_SHIM.mailing_address,
        unsubscribe_url: "https://ai-travelconcierge.com/unsubscribe",
        subject: params.broadcast_subject ?? "Update from your group coordinator",
        message: params.broadcast_message ?? "Hello everyone! Just a quick update — we have 12 cabins confirmed so far and things are coming together beautifully. Please complete your pre-cruise check-in at least 5 days before sailing.\n\nLooking forward to seeing you all on board!",
        group_name: params.group_name ?? "Sample Group Cruise",
      };
      jsx = React.createElement(GroupBroadcast, props);
      break;
    }
  }

  return renderToStaticMarkup(jsx);
}

function subjectForTemplate(template: TemplateId, ship_name: string): string {
  switch (template) {
    case "T90": return `[Sample] Your ${ship_name} cruise is 90 days away!`;
    case "T30": return `[Sample] Final prep — 30 days to ${ship_name}`;
    case "T7": return `[Sample] Almost there — 1 week until ${ship_name}`;
    case "T1": return `[Sample] Tomorrow is the day — ${ship_name}!`;
    case "GroupInvitation": return "[Sample] You're invited to a group cruise!";
    case "GroupBroadcast": return "[Sample] Message from your group coordinator";
  }
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const url = new URL(req.url);
  const parsed = parseSampleParams((k) => url.searchParams.get(k) ?? undefined);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  let html: string;
  try {
    html = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "admin_email_sample_preview", operation: `email_sample.preview.${parsed.template}` },
      async () => buildHtml(parsed),
    );
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const to_email = String(rawBody.to_email ?? "");
  // Cap length before the regex: 254 is the RFC 5321 maximum, and bounding the
  // input neutralizes polynomial backtracking in the validation regex (ReDoS).
  if (!to_email || to_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_email)) {
    return Response.json({ error: "Invalid or missing to_email" }, { status: 400 });
  }

  const parsed = parseSampleParams((k) => {
    const v = rawBody[k];
    return typeof v === "string" ? v : undefined;
  });
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "admin_email_sample_send", operation: `email_sample.send.${parsed.template}` },
      async (db) => {
        const html = await buildHtml(parsed);
        return sendEmail({
          db,
          tenant: PLATFORM_TENANT_SHIM,
          to: to_email,
          subject: subjectForTemplate(parsed.template, parsed.ship_name),
          template_id: "admin_email_sample",
          category: "admin_sample",
          html,
        });
      },
    );

    if (result.status === "rate_limited") {
      return Response.json({ error: "Rate limit reached (50 admin sample emails/day)" }, { status: 429 });
    }
    if (result.status === "failed") {
      return Response.json({ error: result.reason ?? "send_failed" }, { status: 500 });
    }

    return Response.json({ ok: true, resend_message_id: result.resend_message_id ?? null });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
