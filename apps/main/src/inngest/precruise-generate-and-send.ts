// §23.4 — Pre-cruise content generation and email send.
//
// §27.12 batch migration: this function now routes by `event.data.via`:
//   - "direct" (T-1, hourly cron): existing behavior — multiple Haiku
//     calls, build, send. Synchronous within one Inngest run.
//   - "batched" (T-7/T-30/T-90, daily cron): enqueue ONE structured-JSON
//     Haiku request per email via the §27.12 batch pipeline. A separate
//     consumer (precruiseSendFromBatchResult) handles the
//     ai.batch_request.completed event and does the build+send.
//
// The "batched" path also folds 4-5 Haiku calls per email into 1 Haiku
// call with structured JSON output — strictly fewer Anthropic round
// trips even before the batch discount. Direct path keeps the multi-call
// shape since T-1 is low volume and the timing-sensitive customer
// experience benefits from the slightly higher-quality multi-prompt
// content.

import * as React from "react";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { enqueueBatchRequest } from "@/lib/ai/batch/enqueue";
import { sendEmail, type SendEmailInput } from "@/lib/email/send";
import { signCompanionToken } from "@/lib/email/unsubscribe-token";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { PreCruiseT90, type PreCruiseT90Props } from "@/emails/PreCruiseT90";
import { PreCruiseT30, type PreCruiseT30Props } from "@/emails/PreCruiseT30";
import { PreCruiseT7,  type PreCruiseT7Props  } from "@/emails/PreCruiseT7";
import { PreCruiseT1,  type PreCruiseT1Props, type PortInfo } from "@/emails/PreCruiseT1";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";
import { safeAwait } from "@/lib/db/safe-mutation";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

type Phase = "t_90" | "t_30" | "t_7" | "t_1";

async function haikuGenerate(
  tenant_id: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "Content generation unavailable — ANTHROPIC_API_KEY not set.";
  try {
    const { text } = await instrumentedClaudeCall({
      tenant_id,
      model: HAIKU_MODEL,
      purpose: "precruise_generation",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    return text;
  } catch {
    return "Content generation temporarily unavailable.";
  }
}

export const precruiseGenerateAndSend = inngest.createFunction(
  { id: "precruise-generate-and-send", triggers: [{ event: "precruise/email.due" }] },
  async ({ event }) => {
    const { booking_id, tenant_id, phase, via } = event.data as {
      booking_id: string;
      tenant_id: string;
      phase: Phase;
      via?: "direct" | "batched";
    };

    const svc = createServiceRoleClient();

    // §15.16 — Skip past-grace tenants (both paths).
    const paymentCheck = await assertTenantStillPayingById(svc, tenant_id);
    if (!paymentCheck.ok) {
      console.info(
        "[precruise] skipping past-grace tenant",
        { tenant_id, booking_id, phase, reason: paymentCheck.reason, days: paymentCheck.days_since_non_paying },
      );
      return;
    }

    // Idempotency: if already sent, skip (both paths).
    const { data: existingRaw } = await svc
      .from("pre_cruise_email_content")
      .select("id, sent_at, generated_content")
      .eq("booking_id", booking_id)
      .eq("email_phase", phase)
      .maybeSingle();
    const existing = existingRaw as { id: string; sent_at?: string | null; generated_content?: Record<string, unknown> } | null;
    if (existing?.sent_at) {
      console.info(`[precruise] already sent: booking=${booking_id} phase=${phase}`);
      return;
    }

    // Resolve the full email context (shared by both paths).
    const emailCtx = await loadEmailContext({ svc, booking_id, tenant_id, phase });
    if (!emailCtx) return; // already logged

    if (via === "batched") {
      // ── Batched path: enqueue ONE structured-JSON Haiku request and
      // hand off to precruiseSendFromBatchResult on completion.
      const prompt = buildBatchedPrompt(phase, emailCtx);
      await enqueueBatchRequest({
        tenant_id,
        purpose: "precruise_generation",
        request_params: {
          model: HAIKU_MODEL,
          max_tokens: 2048, // wider than direct since it returns combined JSON
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
        },
        caller_metadata: {
          booking_id,
          tenant_id,
          phase,
          email_ctx_id: existing?.id ?? null,
          // Re-encode the parts of the email context the consumer needs
          // without re-querying. Avoids a second round trip + races.
          companion_page_url: emailCtx.companionPageUrl,
        },
        db: svc,
      });
      console.info(`[precruise:batched] enqueued booking=${booking_id} phase=${phase}`);
      return;
    }

    // ── Direct path: existing multi-call generation, render, send.
    let generatedContent: Record<string, unknown>;
    let contentId: string | undefined;
    if (existing?.generated_content) {
      generatedContent = existing.generated_content;
      contentId = existing.id;
    } else {
      generatedContent = await generateContent(phase, emailCtx);
      const { data: inserted } = await svc
        .from("pre_cruise_email_content")
        .insert({
          tenant_id,
          booking_id,
          contact_id: emailCtx.booking.user_id ?? booking_id,
          email_phase: phase,
          generated_content: generatedContent,
          companion_page_url: emailCtx.companionPageUrl,
        })
        .select("id")
        .single();
      contentId = (inserted as { id: string } | null)?.id;
    }

    await buildAndSend({
      svc,
      phase,
      emailCtx,
      generatedContent,
      ...(contentId ? { contentId } : {}),
    });
  },
);

/**
 * NEW: §27.12 — Consumer of ai.batch_request.completed.precruise_generation.
 * Receives the structured-JSON result text, parses, builds the email, sends.
 */
export const precruiseSendFromBatchResult = inngest.createFunction(
  {
    id: "precruise-send-from-batch-result",
    triggers: [{ event: "ai.batch_request.completed.precruise_generation" }],
  },
  async ({ event }) => {
    const { request_id, tenant_id, result_text, caller_metadata } = event.data as {
      request_id: string;
      tenant_id: string;
      result_text: string;
      caller_metadata: {
        booking_id: string;
        tenant_id: string;
        phase: Phase;
        email_ctx_id: string | null;
        companion_page_url: string;
      } | null;
    };
    if (!caller_metadata) {
      console.error(`[precruise:batch-result] missing caller_metadata for request ${request_id}`);
      return;
    }
    const { booking_id, phase } = caller_metadata;
    const svc = createServiceRoleClient();

    // Parse the structured JSON. Tolerate occasional Haiku formatting
    // wrappers (e.g., ```json fences).
    const generatedContent = parseStructuredJson(result_text);
    if (!generatedContent) {
      console.error(`[precruise:batch-result] failed to parse JSON for booking=${booking_id} phase=${phase}`);
      return;
    }

    // Idempotency check again — if a parallel direct fire already sent,
    // don't double-send.
    const { data: existingRaw } = await svc
      .from("pre_cruise_email_content")
      .select("id, sent_at")
      .eq("booking_id", booking_id)
      .eq("email_phase", phase)
      .maybeSingle();
    const existing = existingRaw as { id: string; sent_at?: string | null } | null;
    if (existing?.sent_at) {
      console.info(`[precruise:batch-result] already sent: booking=${booking_id} phase=${phase}`);
      return;
    }

    // Insert the generated_content row (or update if already exists from
    // a partial prior run).
    let contentId: string | undefined = existing?.id;
    if (!contentId) {
      const { data: inserted } = await svc
        .from("pre_cruise_email_content")
        .insert({
          tenant_id,
          booking_id,
          contact_id: booking_id, // bare UUID until contacts table lands
          email_phase: phase,
          generated_content: generatedContent,
          companion_page_url: caller_metadata.companion_page_url,
        })
        .select("id")
        .single();
      contentId = (inserted as { id: string } | null)?.id;
    } else {
      await safeAwait(
        svc
          .from("pre_cruise_email_content")
          .update({ generated_content: generatedContent })
          .eq("id", contentId),
        "pre_cruise_email_content.update.generated",
      );
    }

    const emailCtx = await loadEmailContext({ svc, booking_id, tenant_id, phase });
    if (!emailCtx) return;
    await buildAndSend({ svc, phase, emailCtx, generatedContent, ...(contentId ? { contentId } : {}) });
  },
);

// ── Shared helpers ─────────────────────────────────────────────────────

interface EmailCtx {
  booking: {
    id: string;
    user_id?: string;
    customer_name?: string;
    passenger_contact_email?: string;
    group_id?: string;
    groups?: {
      cruise_line?: string;
      ship_name?: string;
      sailing_date?: string;
      departure_port?: string;
    } | null;
  };
  toEmail: string;
  tenant: {
    id: string;
    legal_name?: string;
    mailing_address?: string;
    email_send_pattern?: string;
    tenant_resend_api_key_encrypted?: string;
    email_from_address?: string;
    email_from_name?: string;
  };
  branding: {
    logo_url?: string;
    primary_color?: string;
    secondary_color?: string;
    accent_color?: string;
    slogan?: string;
  };
  customerName: string;
  shipName: string;
  cruiseLine: string;
  sailingDate: string;
  ports: string[];
  departurePort?: string;
  companionPageUrl: string;
  unsubscribeUrl: string;
  layoutProps: Omit<BrandedLayoutProps, "children">;
}

// Exported for unit testing the data-access shape (the bookings→groups
// SELECT must not reference columns that don't exist on `groups`).
export async function loadEmailContext(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  booking_id: string;
  tenant_id: string;
  phase: Phase;
}): Promise<EmailCtx | null> {
  const { svc, booking_id, tenant_id, phase } = args;

  const { data: bookingRaw } = await svc
    .from("bookings")
    .select(
      "id, tenant_id, group_id, user_id, customer_name, passenger_contact_email, groups(cruise_line, ship_name, sailing_date, departure_port)",
    )
    .eq("id", booking_id)
    .maybeSingle();
  if (!bookingRaw) {
    console.error(`[precruise] booking not found: ${booking_id}`);
    return null;
  }
  const booking = bookingRaw as EmailCtx["booking"];
  const toEmail = booking.passenger_contact_email;
  if (!toEmail) {
    console.warn(`[precruise] no contact email for booking ${booking_id}`);
    return null;
  }

  const { data: tenantRaw } = await svc
    .from("tenants")
    .select(
      "id, legal_name, mailing_address, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name",
    )
    .eq("id", tenant_id)
    .maybeSingle();
  const tenant = tenantRaw as EmailCtx["tenant"] | null;
  if (!tenant) {
    console.error(`[precruise] tenant not found: ${tenant_id}`);
    return null;
  }

  const { data: brandingRaw } = await svc
    .from("tenant_branding")
    .select("logo_url, primary_color, secondary_color, accent_color, slogan")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const branding = (brandingRaw as EmailCtx["branding"] | null) ?? {};

  const customerName = booking.customer_name ?? "Traveler";
  const shipName = booking.groups?.ship_name ?? "your ship";
  const cruiseLine = booking.groups?.cruise_line ?? "";
  const sailingDate = booking.groups?.sailing_date ?? "";
  // Per-stop itinerary (ports of call) isn't captured yet — the DIY
  // CruiseMapper scraper has no sailing parser (#485). Until that lands,
  // the ports list is empty and the destination-image / multi-day-forecast
  // wiring (#487) stays inert. The departure port DOES exist on groups.
  const ports: string[] = [];
  const departurePort = booking.groups?.departure_port;

  const companionToken = signCompanionToken({ booking_id, phase });
  const baseUrl = process.env.PLATFORM_PRIMARY_DOMAIN
    ? `https://${tenant_id}.${process.env.PLATFORM_PRIMARY_DOMAIN}`
    : "https://app.ai-travelconcierge.com";
  const companionPageUrl = `${baseUrl}/companion/${companionToken}`;

  const unsubToken = signUnsubscribeToken({ email: toEmail, tenant_id, category: "pre_cruise" });
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

  return {
    booking,
    toEmail,
    tenant,
    branding,
    customerName,
    shipName,
    cruiseLine,
    sailingDate,
    ports,
    ...(departurePort ? { departurePort } : {}),
    companionPageUrl,
    unsubscribeUrl,
    layoutProps,
  };
}

async function buildAndSend(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  phase: Phase;
  emailCtx: EmailCtx;
  generatedContent: Record<string, unknown>;
  contentId?: string;
}): Promise<void> {
  const { svc, phase, emailCtx, generatedContent, contentId } = args;

  let portInfo: PortInfo | null = null;
  if (phase === "t_1" && emailCtx.departurePort) {
    const PORT_COLS =
      "port_name, official_url, terminal_addresses, parking_info, transit_dropoff_info, arrival_advice";
    const dp = emailCtx.departurePort;
    // groups.departure_port is free TEXT — could be an IATA-style code
    // ('MIA') or a name ('Miami, FL'). Match on port_code first, then
    // port_name. Two exact .eq() queries rather than one .or(), because
    // a port name like "Miami, FL" contains a comma that would break
    // PostgREST's comma-delimited .or() filter. (#484 replaces this with
    // an alias-aware lookupPortByName.)
    const byCode = await svc.from("port_info_chunks").select(PORT_COLS).eq("port_code", dp).maybeSingle();
    portInfo = (byCode.data as PortInfo | null) ?? null;
    if (!portInfo) {
      const byName = await svc.from("port_info_chunks").select(PORT_COLS).eq("port_name", dp).maybeSingle();
      portInfo = (byName.data as PortInfo | null) ?? null;
    }
  }

  const { html, subject } = await buildEmail(phase, {
    layoutProps: emailCtx.layoutProps,
    customerName: emailCtx.customerName,
    shipName: emailCtx.shipName,
    cruiseLine: emailCtx.cruiseLine,
    sailingDate: emailCtx.sailingDate,
    ports: emailCtx.ports,
    generatedContent,
    companionPageUrl: emailCtx.companionPageUrl,
    portInfo,
  });

  const tenantInput: SendEmailInput["tenant"] = {
    id: emailCtx.tenant.id,
    legal_name: emailCtx.tenant.legal_name ?? "Travel Agency",
    mailing_address: emailCtx.tenant.mailing_address ?? null,
    email_send_pattern: (emailCtx.tenant.email_send_pattern ?? "platform_resend") as
      | "platform_resend"
      | "tenant_resend",
    tenant_resend_api_key_encrypted: emailCtx.tenant.tenant_resend_api_key_encrypted ?? null,
    email_from_address: emailCtx.tenant.email_from_address ?? null,
    email_from_name: emailCtx.tenant.email_from_name ?? null,
  };

  const result = await sendEmail({
    db: svc,
    tenant: tenantInput,
    to: emailCtx.toEmail,
    subject,
    template_id: `pre_cruise_${phase}`,
    category: "pre_cruise",
    html,
    ...(emailCtx.booking.user_id ? { user_id: emailCtx.booking.user_id } : {}),
    ...(emailCtx.booking.group_id ? { related_group_id: emailCtx.booking.group_id } : {}),
  });

  if (result.status === "sent" && contentId) {
    await safeAwait(
      svc
        .from("pre_cruise_email_content")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", contentId),
      "pre_cruise_email_content.update.sent_at",
    );
  }

  console.info(
    `[precruise] booking=${emailCtx.booking.id} phase=${phase} status=${result.status}`,
  );
}

function buildBatchedPrompt(
  phase: Phase,
  ctx: EmailCtx,
): { system: string; user: string } {
  // One structured-JSON request per email — replaces the 4-5 separate
  // direct-path Haiku calls. Lower token cost AND cleaner consumer.
  const sys = [
    `You are a travel concierge generating pre-cruise email content for ${ctx.customerName}.`,
    `The cruise is on ${ctx.shipName} (${ctx.cruiseLine}), sailing ${ctx.sailingDate}.`,
    `Ports: ${ctx.ports.join(", ") || "TBD"}.`,
    "",
    "Return ONLY a JSON object — no prose, no code fences. All fields must be present even if empty arrays / strings.",
  ].join("\n");

  switch (phase) {
    case "t_90":
      return {
        system: sys,
        user: `Generate the T-90 pre-cruise email content as JSON with these exact keys:
{
  "documentation_reminder": "string (2 sentences — passport validity, travel insurance, visa check)",
  "destination_teaser": "string (2-3 sentences — exciting preview of the ports)",
  "must_do_experiences": ["string", "string", "string"],
  "did_you_know": "string (1-2 sentences — fascinating fact about cruising or the ports)",
  "suggested_reads": []
}`,
      };
    case "t_30":
      return {
        system: sys,
        user: `Generate the T-30 pre-cruise email content as JSON with these exact keys:
{
  "reservation_reminders": ["Specialty dining reservations", "Shore excursions", "Spa appointments"],
  "checkin_window": "string (2 sentences — when online check-in opens and why to do it early)",
  "final_payment_note": null,
  "personalized_recommendations": ["string", "string", "string"],
  "specialty_experiences": [],
  "pack_inspiration": "string (2-3 sentences — packing inspiration / style tips for this cruise)"
}`,
      };
    case "t_7":
      return {
        system: sys,
        user: `Generate the T-7 pre-cruise email content as JSON with these exact keys:
{
  "packing_checklist": ["8 essential items"],
  "ship_highlights": ["string", "string", "string"],
  "cruise_line_tips": ["string", "string", "string"],
  "embarkation_advice": "string (2-3 sentences — what to expect on embarkation day)",
  "first_day_inspiration": "string (2 sentences — the magic of the first day aboard)"
}`,
      };
    case "t_1":
      // T-1 should never hit the batched path (scheduler skips it) but
      // defining the prompt makes the consumer DRY-safe if the
      // discriminator slips.
      return {
        system: sys,
        user: `Generate the T-1 pre-cruise email content as JSON with these exact keys:
{
  "first_port_preview": "string (2 sentences — exciting preview of the first port of call)",
  "day_of_expectations": "string (2-3 sentences — check-in time, muster drill, sail-away)"
}`,
      };
  }
}

function parseStructuredJson(text: string): Record<string, unknown> | null {
  // Tolerate ```json fences and leading/trailing prose Haiku
  // occasionally appends. Find the outermost { ... } substring.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  if (!candidate) return null;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Direct-path generation (T-1, hourly cron) ─────────────────────────

async function generateContent(
  phase: Phase,
  ctx: EmailCtx,
): Promise<Record<string, unknown>> {
  const tenant_id = ctx.tenant.id;
  const sys = `You are a travel concierge generating pre-cruise email content for ${ctx.customerName}.
The cruise is on ${ctx.shipName} (${ctx.cruiseLine}), sailing ${ctx.sailingDate}.
Ports: ${ctx.ports.join(", ") || "TBD"}.
Return concise, enthusiastic, and practical content. Keep each field to 1-3 sentences unless specified.`;

  switch (phase) {
    case "t_90": {
      const [docReminder, teaser, didYouKnow] = await Promise.all([
        haikuGenerate(tenant_id, sys, "Write a friendly documentation reminder (passport validity, travel insurance, visa check) in 2 sentences."),
        haikuGenerate(tenant_id, sys, "Write an exciting destination teaser for the ports in 2-3 sentences."),
        haikuGenerate(tenant_id, sys, "Share one fascinating did-you-know fact about cruising or the ports in 1-2 sentences."),
      ]);
      const experiences = await haikuGenerate(tenant_id, sys, "List 3 must-do experiences at these ports, one per line, no bullet points.");
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
        haikuGenerate(tenant_id, sys, "Explain the online check-in window and why to do it early, in 2 sentences."),
        haikuGenerate(tenant_id, sys, "Give packing inspiration / style tips for this cruise, in 2-3 sentences."),
      ]);
      const recs = await haikuGenerate(tenant_id, sys, "List 3 personalized recommendations (specialty dining, excursions, spa) one per line, no bullet points.");
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
        haikuGenerate(tenant_id, sys, "Generate a concise packing checklist of 8 essential items, one per line, no bullet points."),
        haikuGenerate(tenant_id, sys, "Describe what to expect on embarkation day in 2-3 sentences."),
        haikuGenerate(tenant_id, sys, "Describe the magic of the first day aboard in 2 sentences."),
      ]);
      const highlights = await haikuGenerate(tenant_id, sys, "List 3 ship highlights one per line, no bullet points.");
      const tips = await haikuGenerate(tenant_id, sys, "Give 3 cruise-line-specific tips one per line, no bullet points.");
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
        haikuGenerate(tenant_id, sys, "Write an exciting preview of the first port of call in 2 sentences."),
        haikuGenerate(tenant_id, sys, "Describe what to expect on departure day: check-in time, muster drill, sail-away in 2-3 sentences."),
      ]);
      return {
        first_port_preview: firstPort,
        day_of_expectations: dayOf,
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

// Re-export parseStructuredJson for tests.
export { parseStructuredJson };
