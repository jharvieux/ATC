// §23.4 — Pre-cruise content generation and email send.
//
// Triggered by precruise/email.due { booking_id, tenant_id, phase }.
//
// For each phase, generates content via Haiku (cached in pre_cruise_email_content),
// renders the matching template, and calls sendEmail.
//
// T-1 phase reads port_info_chunks for the departure port. Weather integration
// is deferred — TODO(weather-integration).

import * as React from "react";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import { signCompanionToken } from "@/lib/email/unsubscribe-token";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { PreCruiseT90, type PreCruiseT90Props } from "@/emails/PreCruiseT90";
import { PreCruiseT30, type PreCruiseT30Props } from "@/emails/PreCruiseT30";
import { PreCruiseT7,  type PreCruiseT7Props  } from "@/emails/PreCruiseT7";
import { PreCruiseT1,  type PreCruiseT1Props, type PortInfo } from "@/emails/PreCruiseT1";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

type Phase = "t_90" | "t_30" | "t_7" | "t_1";

async function haikuGenerate(systemPrompt: string, userPrompt: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "Content generation unavailable — ANTHROPIC_API_KEY not set.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) return "Content generation temporarily unavailable.";
  const body = await res.json() as { content?: Array<{ text?: string }> };
  return body.content?.[0]?.text ?? "";
}

export const precruiseGenerateAndSend = inngest.createFunction(
  { id: "precruise-generate-and-send", triggers: [{ event: "precruise/email.due" }] },
  async ({ event }) => {
    const { booking_id, tenant_id, phase } = event.data as {
      booking_id: string;
      tenant_id: string;
      phase: Phase;
    };

    const svc = createServiceRoleClient();

    // Idempotency: if already sent, skip
    const { data: existing } = await svc
      .from("pre_cruise_email_content")
      .select("id, sent_at")
      .eq("booking_id", booking_id)
      .eq("email_phase", phase)
      .maybeSingle();

    if (existing && (existing as { sent_at?: string }).sent_at) {
      console.info(`[precruise] already sent: booking=${booking_id} phase=${phase}`);
      return;
    }

    // Load booking + tenant context
    const { data: bookingRaw } = await svc
      .from("bookings")
      .select("id, tenant_id, group_id, user_id, customer_name, passenger_contact_email, groups(cruise_line, ship_name, sailing_date, departure_port_code, itinerary_ports)")
      .eq("id", booking_id)
      .maybeSingle();

    if (!bookingRaw) {
      console.error(`[precruise] booking not found: ${booking_id}`);
      return;
    }

    const booking = bookingRaw as {
      id: string;
      tenant_id: string;
      group_id?: string;
      user_id?: string;
      customer_name?: string;
      passenger_contact_email?: string;
      groups?: {
        cruise_line?: string;
        ship_name?: string;
        sailing_date?: string;
        departure_port_code?: string;
        itinerary_ports?: string[];
      } | null;
    };

    const toEmail = booking.passenger_contact_email;
    if (!toEmail) {
      console.warn(`[precruise] no contact email for booking ${booking_id}`);
      return;
    }

    // Load tenant branding
    const { data: tenantRaw } = await svc
      .from("tenants")
      .select("id, legal_name, mailing_address, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name")
      .eq("id", tenant_id)
      .maybeSingle();

    const tenant = tenantRaw as {
      id: string;
      legal_name?: string;
      mailing_address?: string;
      email_send_pattern?: string;
      tenant_resend_api_key_encrypted?: string;
      email_from_address?: string;
      email_from_name?: string;
    } | null;

    if (!tenant) {
      console.error(`[precruise] tenant not found: ${tenant_id}`);
      return;
    }

    const { data: brandingRaw } = await svc
      .from("tenant_branding")
      .select("logo_url, primary_color, secondary_color, accent_color, slogan")
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    const branding = (brandingRaw as {
      logo_url?: string;
      primary_color?: string;
      secondary_color?: string;
      accent_color?: string;
      slogan?: string;
    } | null) ?? {};

    const customerName = booking.customer_name ?? "Traveler";
    const shipName = booking.groups?.ship_name ?? "your ship";
    const cruiseLine = booking.groups?.cruise_line ?? "";
    const sailingDate = booking.groups?.sailing_date ?? "";
    const ports = booking.groups?.itinerary_ports ?? [];
    const departurePortCode = booking.groups?.departure_port_code;

    // Build companion page URL
    const companionToken = signCompanionToken({ booking_id, phase });
    const baseUrl = process.env.PLATFORM_PRIMARY_DOMAIN
      ? `https://${tenant_id}.${process.env.PLATFORM_PRIMARY_DOMAIN}`
      : "https://app.ai-travelconcierge.com";
    const companionPageUrl = `${baseUrl}/companion/${companionToken}`;

    // Build unsubscribe URL
    const unsubToken = signUnsubscribeToken({
      email: toEmail,
      tenant_id,
      category: "pre_cruise",
    });
    const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${unsubToken}`;

    const layoutProps: Omit<BrandedLayoutProps, "children"> = {
      branding: {
        logo_url: branding.logo_url ?? null,
        primary_color: branding.primary_color ?? null,
        secondary_color: branding.secondary_color ?? null,
        accent_color: branding.accent_color ?? null,
        slogan: branding.slogan ?? null,
      },
      tenant_legal_name: tenant.legal_name ?? "Travel Agency",
      tenant_business_address: tenant.mailing_address ?? "",
      unsubscribe_url: unsubscribeUrl,
    };

    // Generate or use cached content
    let generatedContent: Record<string, unknown>;
    let contentId: string | undefined;

    if (existing && (existing as { id: string }).id) {
      const { data: existingContent } = await svc
        .from("pre_cruise_email_content")
        .select("id, generated_content")
        .eq("id", (existing as { id: string }).id)
        .maybeSingle();
      generatedContent = (existingContent as { generated_content: Record<string, unknown> } | null)?.generated_content ?? {};
      contentId = (existingContent as { id: string } | null)?.id;
    } else {
      generatedContent = await generateContent(phase, {
        customerName, shipName, cruiseLine, sailingDate, ports,
      });

      const { data: inserted } = await svc
        .from("pre_cruise_email_content")
        .insert({
          tenant_id,
          booking_id,
          contact_id: booking.user_id ?? booking_id, // bare UUID until contacts table lands
          email_phase: phase,
          generated_content: generatedContent,
          companion_page_url: companionPageUrl,
        })
        .select("id")
        .single();
      contentId = (inserted as { id: string } | null)?.id;
    }

    // Load port info for T-1
    let portInfo: PortInfo | null = null;
    if (phase === "t_1" && departurePortCode) {
      const { data: portRaw } = await svc
        .from("port_info_chunks")
        .select("port_name, official_url, terminal_addresses, parking_info, transit_dropoff_info, arrival_advice")
        .eq("port_code", departurePortCode)
        .maybeSingle();
      portInfo = (portRaw as PortInfo | null);
    }

    // Build HTML + subject (dynamic import avoids Next.js bundler react-dom/server restriction)
    const { html, subject } = await buildEmail(phase, {
      layoutProps,
      customerName,
      shipName,
      cruiseLine,
      sailingDate,
      ports,
      generatedContent,
      companionPageUrl,
      portInfo,
    });

    const tenantInput: SendEmailInput["tenant"] = {
      id: tenant.id,
      legal_name: tenant.legal_name ?? "Travel Agency",
      mailing_address: tenant.mailing_address ?? null,
      email_send_pattern: (tenant.email_send_pattern ?? "platform_resend") as "platform_resend" | "tenant_resend",
      tenant_resend_api_key_encrypted: tenant.tenant_resend_api_key_encrypted ?? null,
      email_from_address: tenant.email_from_address ?? null,
      email_from_name: tenant.email_from_name ?? null,
    };

    const result = await sendEmail({
      db: svc,
      tenant: tenantInput,
      to: toEmail,
      subject,
      template_id: `pre_cruise_${phase}`,
      category: "pre_cruise",
      html,
      ...(booking.user_id ? { user_id: booking.user_id } : {}),
      ...(booking.group_id ? { related_group_id: booking.group_id } : {}),
    });

    if (result.status === "sent" && contentId) {
      await svc
        .from("pre_cruise_email_content")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", contentId);
    }

    console.info(`[precruise] booking=${booking_id} phase=${phase} status=${result.status}`);
  },
);

async function generateContent(
  phase: Phase,
  ctx: {
    customerName: string;
    shipName: string;
    cruiseLine: string;
    sailingDate: string;
    ports: string[];
  },
): Promise<Record<string, unknown>> {
  const sys = `You are a travel concierge generating pre-cruise email content for ${ctx.customerName}.
The cruise is on ${ctx.shipName} (${ctx.cruiseLine}), sailing ${ctx.sailingDate}.
Ports: ${ctx.ports.join(", ") || "TBD"}.
Return concise, enthusiastic, and practical content. Keep each field to 1-3 sentences unless specified.`;

  switch (phase) {
    case "t_90": {
      const [docReminder, teaser, didYouKnow] = await Promise.all([
        haikuGenerate(sys, "Write a friendly documentation reminder (passport validity, travel insurance, visa check) in 2 sentences."),
        haikuGenerate(sys, "Write an exciting destination teaser for the ports in 2-3 sentences."),
        haikuGenerate(sys, "Share one fascinating did-you-know fact about cruising or the ports in 1-2 sentences."),
      ]);
      const experiences = await haikuGenerate(sys, "List 3 must-do experiences at these ports, one per line, no bullet points.");
      return {
        documentation_reminder: docReminder,
        destination_teaser: teaser,
        must_do_experiences: experiences.split("\n").filter(Boolean).slice(0, 3),
        did_you_know: didYouKnow,
        suggested_reads: [],
      };
    }
    case "t_30": {
      const [checkin, packInspiration] = await Promise.all([
        haikuGenerate(sys, "Explain the online check-in window and why to do it early, in 2 sentences."),
        haikuGenerate(sys, "Give packing inspiration / style tips for this cruise, in 2-3 sentences."),
      ]);
      const recs = await haikuGenerate(sys, "List 3 personalized recommendations (specialty dining, excursions, spa) one per line, no bullet points.");
      return {
        reservation_reminders: ["Specialty dining reservations", "Shore excursions", "Spa appointments"],
        checkin_window: checkin,
        final_payment_note: null,
        personalized_recommendations: recs.split("\n").filter(Boolean).slice(0, 3),
        pack_inspiration: packInspiration,
      };
    }
    case "t_7": {
      const [packingRaw, embarkation, firstDay] = await Promise.all([
        haikuGenerate(sys, "Generate a concise packing checklist of 8 essential items, one per line, no bullet points."),
        haikuGenerate(sys, "Describe what to expect on embarkation day in 2-3 sentences."),
        haikuGenerate(sys, "Describe the magic of the first day aboard in 2 sentences."),
      ]);
      const highlights = await haikuGenerate(sys, "List 3 ship highlights one per line, no bullet points.");
      const tips = await haikuGenerate(sys, "Give 3 cruise-line-specific tips one per line, no bullet points.");
      return {
        packing_checklist: packingRaw.split("\n").filter(Boolean).slice(0, 8),
        ship_highlights: highlights.split("\n").filter(Boolean).slice(0, 3),
        cruise_line_tips: tips.split("\n").filter(Boolean).slice(0, 3),
        embarkation_advice: embarkation,
        first_day_inspiration: firstDay,
      };
    }
    case "t_1": {
      const [firstPort, dayOf] = await Promise.all([
        haikuGenerate(sys, "Write an exciting preview of the first port of call in 2 sentences."),
        haikuGenerate(sys, "Describe what to expect on departure day: check-in time, muster drill, sail-away in 2-3 sentences."),
      ]);
      return {
        first_port_preview: firstPort,
        day_of_expectations: dayOf,
        // weather_summary: TODO(weather-integration)
      };
    }
  }
}

async function buildEmail(
  phase: Phase,
  ctx: {
    layoutProps: Omit<BrandedLayoutProps, "children">;
    customerName: string;
    shipName: string;
    cruiseLine: string;
    sailingDate: string;
    ports: string[];
    generatedContent: Record<string, unknown>;
    companionPageUrl: string;
    portInfo: PortInfo | null;
  },
): Promise<{ html: string; subject: string }> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { layoutProps, customerName, shipName, cruiseLine, sailingDate, ports, generatedContent: c, companionPageUrl, portInfo } = ctx;

  switch (phase) {
    case "t_90": {
      const props: PreCruiseT90Props = {
        layout: layoutProps,
        customer_name: customerName,
        ship_name: shipName,
        cruise_line: cruiseLine,
        sailing_date: sailingDate,
        ports,
        documentation_reminder: (c.documentation_reminder as string) ?? "",
        destination_teaser: (c.destination_teaser as string) ?? "",
        must_do_experiences: (c.must_do_experiences as string[]) ?? [],
        did_you_know: (c.did_you_know as string) ?? "",
        suggested_reads: (c.suggested_reads as string[]) ?? [],
      };
      return {
        html: renderToStaticMarkup(React.createElement(PreCruiseT90, props)),
        subject: `90 days to your ${cruiseLine} cruise — let the anticipation begin!`,
      };
    }
    case "t_30": {
      const props: PreCruiseT30Props = {
        layout: layoutProps,
        customer_name: customerName,
        ship_name: shipName,
        sailing_date: sailingDate,
        reservation_reminders: (c.reservation_reminders as string[]) ?? [],
        checkin_window: (c.checkin_window as string) ?? "",
        final_payment_note: (c.final_payment_note as string | null | undefined) ?? null,
        personalized_recommendations: (c.personalized_recommendations as string[]) ?? [],
        specialty_experiences: [],
        pack_inspiration: (c.pack_inspiration as string) ?? "",
        companion_page_url: companionPageUrl,
      };
      return {
        html: renderToStaticMarkup(React.createElement(PreCruiseT30, props)),
        subject: `30 days out — final prep for ${shipName}`,
      };
    }
    case "t_7": {
      const props: PreCruiseT7Props = {
        layout: layoutProps,
        customer_name: customerName,
        ship_name: shipName,
        sailing_date: sailingDate,
        packing_checklist: (c.packing_checklist as string[]) ?? [],
        ship_highlights: (c.ship_highlights as string[]) ?? [],
        cruise_line_tips: (c.cruise_line_tips as string[]) ?? [],
        embarkation_advice: (c.embarkation_advice as string) ?? "",
        first_day_inspiration: (c.first_day_inspiration as string) ?? "",
        companion_page_url: companionPageUrl,
      };
      return {
        html: renderToStaticMarkup(React.createElement(PreCruiseT7, props)),
        subject: `One week away — pack, prepare, and get excited!`,
      };
    }
    case "t_1": {
      const props: PreCruiseT1Props = {
        layout: layoutProps,
        customer_name: customerName,
        ship_name: shipName,
        departure_port: portInfo,
        first_port_preview: (c.first_port_preview as string) ?? "",
        day_of_expectations: (c.day_of_expectations as string) ?? "",
        weather_summary: (c.weather_summary as string | null | undefined) ?? null,
        companion_page_url: companionPageUrl,
      };
      return {
        html: renderToStaticMarkup(React.createElement(PreCruiseT1, props)),
        subject: `Tomorrow! Your ${cruiseLine} cruise departs — final checklist inside`,
      };
    }
  }
}
