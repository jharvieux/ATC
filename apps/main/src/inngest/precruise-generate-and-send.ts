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
import { createHash } from "node:crypto";
import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { enqueueBatchRequest } from "@/lib/ai/batch/enqueue";
import {
  abandonUnstartedIdempotentEmail,
  recoverIdempotentEmail,
  resumeIdempotentEmail,
  sendEmail,
  type SendEmailInput,
  TENANT_BRANDING_COLUMNS,
} from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { signCompanionToken } from "@/lib/email/unsubscribe-token";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";
import { PreCruiseT90, type PreCruiseT90Props } from "@/emails/PreCruiseT90";
import { PreCruiseT30, type PreCruiseT30Props } from "@/emails/PreCruiseT30";
import { PreCruiseT7,  type PreCruiseT7Props  } from "@/emails/PreCruiseT7";
import { PreCruiseT1,  type PreCruiseT1Props, type PortInfo } from "@/emails/PreCruiseT1";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";
import { safeAwait, safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";
import { revalidateCompanionContent } from "@/lib/precruise/companion-content";
import { getSailingItinerary } from "@/lib/sailings/sailing-itinerary";
import { resolveDestinationRegion } from "@/lib/cruise-regions/classify";
import { getDestinationImage, type DestinationImage } from "@/lib/cruise-regions/destination-images";
import { getCruiseForecast, type DailyForecast } from "@/lib/weather/cruise-forecast";
import { interpolateSeaDays, type ItineraryDay } from "@/lib/weather/sea-day-interpolation";
import { lookupPortByName } from "@/lib/ports/lookup-by-name";
import { validateInngestEvent } from "@/lib/inngest/event-registry";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

type Phase = "t_90" | "t_30" | "t_7" | "t_1";

const PhaseEnum = z.enum(["t_90", "t_30", "t_7", "t_1"]);

const PrecruiseEmailDuePayloadSchema = z.object({
  booking_id: z.string(),
  tenant_id: z.string(),
  phase: PhaseEnum,
  via: z.enum(["direct", "batched"]).optional(),
  expected_contact_id: z.string().optional(),
  expected_contact_email: z.string().email().optional(),
}).refine(
  (value) => Boolean(value.expected_contact_id) === Boolean(value.expected_contact_email),
  { message: "expected contact id and email must be provided together" },
);

const PrecruiseBatchResultPayloadSchema = z.object({
  request_id: z.string(),
  tenant_id: z.string(),
  result_text: z.string(),
  caller_metadata: z.object({
    booking_id: z.string(),
    tenant_id: z.string(),
    phase: PhaseEnum,
    email_ctx_id: z.string().nullable(),
    companion_page_url: z.string(),
    content_context_hash: z.string().optional(),
    expected_contact_id: z.string().optional(),
    expected_contact_email: z.string().email().optional(),
  }).refine(
    (value) => Boolean(value.expected_contact_id) === Boolean(value.expected_contact_email),
    { message: "expected contact id and email must be provided together" },
  ).nullable(),
});

const SEND_CLAIM_TTL_MS = 30 * 60_000;
const PROVIDER_REPLAY_CUTOFF_MS = 23 * 60 * 60_000;

interface ExistingPrecruiseContent {
  id: string;
  sent_at?: string | null;
  send_claimed_at?: string | null;
  generated_content?: Record<string, unknown>;
  content_context_hash?: string | null;
}

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
  // retries: 3 — #1582: buildAndSend throws on a transient send failure so
  // Inngest retries the whole run with backoff instead of silently losing it.
  { id: "precruise-generate-and-send", retries: 3, triggers: [{ event: "precruise/email.due" }] },
  async ({ event, step }) => {
    validateInngestEvent("precruise/email.due", event.data);
    const parsed = PrecruiseEmailDuePayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[precruise-generate-and-send] invalid event payload: %s", parsed.error.message);
      return;
    }
    const { booking_id, tenant_id, phase, via, expected_contact_id, expected_contact_email } = parsed.data;

    const svc = createServiceRoleClient();

    // Recover local success before any regeneration or billing gate. A prior
    // attempt may have committed the atomic email effects and crashed before
    // stamping this companion row.
    const { data: existingRaw } = await svc
      .from("pre_cruise_email_content")
      .select("id, sent_at, send_claimed_at, generated_content, content_context_hash")
      .eq("booking_id", booking_id)
      .eq("tenant_id", tenant_id)
      .eq("email_phase", phase)
      .maybeSingle();
    const existing = existingRaw as ExistingPrecruiseContent | null;
    const recovery = existing
      ? await recoverExistingPrecruiseSend({ svc, existing, tenantId: tenant_id, bookingId: booking_id, phase })
      : { status: "missing" as const };
    if (recovery.status === "sent") {
      return;
    }
    if (
      recovery.status === "queued"
      && recovery.providerAttemptState === "ambiguous"
      && recovery.providerFirstAttemptAt
    ) {
      await resumeStartedPrecruiseOutbox({
        svc,
        existing: existing!,
        tenantId: tenant_id,
        bookingId: booking_id,
        phase,
        providerFirstAttemptAt: recovery.providerFirstAttemptAt,
      });
      return;
    }

    // §15.16 — Skip past-grace tenants (both paths).
    const paymentCheck = await assertTenantStillPayingById(svc, tenant_id);
    if (!paymentCheck.ok) {
      if (recovery.status === "queued") {
        await abandonRecoveredPrecruiseOutbox({ svc, existing: existing!, tenantId: tenant_id, bookingId: booking_id, phase });
      }
      console.info(
        "[precruise] skipping past-grace tenant",
        { tenant_id, booking_id, phase, reason: paymentCheck.reason, days: paymentCheck.days_since_non_paying },
      );
      return;
    }

    // Resolve the full email context (shared by both paths).
    const emailCtx = await loadEmailContext({ svc, booking_id, tenant_id, phase });
    if (!emailCtx) {
      if (recovery.status === "queued") {
        await abandonRecoveredPrecruiseOutbox({ svc, existing: existing!, tenantId: tenant_id, bookingId: booking_id, phase });
      }
      return;
    }
    if (
      expected_contact_id && expected_contact_email &&
      (emailCtx.booking.primary_contact_id !== expected_contact_id ||
        normalizeEmail(emailCtx.toEmail) !== normalizeEmail(expected_contact_email))
    ) {
      if (recovery.status === "queued") {
        await abandonRecoveredPrecruiseOutbox({ svc, existing: existing!, tenantId: tenant_id, bookingId: booking_id, phase });
      }
      console.info(`[precruise] reviewed recipient changed: booking=${booking_id} phase=${phase}`);
      return;
    }
    const contentContextFingerprint = fingerprintEmailContext(emailCtx);
    if (recovery.status === "queued" && existing?.content_context_hash !== contentContextFingerprint) {
      const canRegenerate = await abandonRecoveredPrecruiseOutbox({
        svc,
        existing: existing!,
        tenantId: tenant_id,
        bookingId: booking_id,
        phase,
      });
      if (!canRegenerate) return;
    }

    if (existing?.send_claimed_at) {
      await buildAndSend({ svc, phase, emailCtx, contentId: existing.id });
      return;
    }

    if (via === "batched") {
      if (
        existing?.generated_content &&
        existing.content_context_hash === contentContextFingerprint
      ) {
        await buildAndSend({ svc, phase, emailCtx, contentId: existing.id });
        return;
      }
      // ── Batched path: enqueue ONE structured-JSON Haiku request and
      // hand off to precruiseSendFromBatchResult on completion.
      await step.run(
        `enqueue-batch:${phase}:${contentContextFingerprint}`,
        () => enqueuePrecruiseBatchGeneration({
          svc,
          booking_id,
          tenant_id,
          phase,
          emailCtx,
          emailCtxId: existing?.id ?? null,
          contentContextFingerprint,
          ...(expected_contact_id ? { expectedContactId: expected_contact_id } : {}),
          ...(expected_contact_email ? { expectedContactEmail: expected_contact_email } : {}),
        }),
      );
      console.info(`[precruise:batched] enqueued booking=${booking_id} phase=${phase}`);
      return;
    }

    // ── Direct path: existing multi-call generation, render, send.
    let contentId: string | undefined;
    if (
      existing?.generated_content &&
      existing.content_context_hash === contentContextFingerprint
    ) {
      contentId = existing.id;
    } else {
      const generatedContent = await step.run(
        `generate-direct:${phase}:${contentContextFingerprint}`,
        () => generateContent(phase, emailCtx),
      );
      if (existing) {
        let updateQuery = svc
          .from("pre_cruise_email_content")
          .update({
            contact_id: emailCtx.booking.primary_contact_id!,
            generated_content: generatedContent,
            content_context_hash: contentContextFingerprint,
            companion_page_url: emailCtx.companionPageUrl,
            generated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .eq("tenant_id", tenant_id)
          .is("sent_at", null)
          .is("send_claimed_at", null);
        updateQuery = existing.content_context_hash === null || existing.content_context_hash === undefined
          ? updateQuery.is("content_context_hash", null)
          : updateQuery.eq("content_context_hash", existing.content_context_hash);
        const updated = await safeAwait(
          updateQuery.select("id"),
          "pre_cruise_email_content.update.regenerated",
        );
        if ((updated as Array<{ id: string }> | null)?.length !== 1) {
          console.info(`[precruise] content changed while regenerating, skipping: booking=${booking_id} phase=${phase}`);
          return;
        }
        contentId = existing.id;
      } else {
        const { data: inserted, error: insertError } = await svc
          .from("pre_cruise_email_content")
          .insert({
            tenant_id,
            booking_id,
            contact_id: emailCtx.booking.primary_contact_id!,
            email_phase: phase,
            generated_content: generatedContent,
            content_context_hash: contentContextFingerprint,
            companion_page_url: emailCtx.companionPageUrl,
          })
          .select("id")
          .single();
        if (insertError?.code === "23505") {
          // #1582: duplicate-event race — another run already claimed
          // (booking_id, email_phase). Let that run own the send.
          console.info(`[precruise] duplicate insert race, skipping send: booking=${booking_id} phase=${phase}`);
          return;
        }
        if (insertError) throw new SupabaseMutationError("pre_cruise_email_content.insert", insertError);
        contentId = (inserted as { id: string } | null)?.id;
      }
      // #1953 — the companion page caches this row by (booking_id, phase);
      // purge so a previously-cached "no content yet" render can't persist.
      revalidateCompanionContent(booking_id, phase);
    }

    if (!contentId) throw new Error("pre-cruise content row did not return an id");
    await buildAndSend({
      svc,
      phase,
      emailCtx,
      contentId,
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
    retries: 3,
    triggers: [{ event: "ai.batch_request.completed.precruise_generation" }],
  },
  async ({ event, step }) => {
    validateInngestEvent("ai.batch_request.completed.precruise_generation", event.data);
    const parsed = PrecruiseBatchResultPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[precruise:batch-result] invalid event payload: %s", parsed.error.message);
      return;
    }
    const { request_id, tenant_id, result_text, caller_metadata } = parsed.data;
    if (!caller_metadata) {
      console.error(`[precruise:batch-result] missing caller_metadata for request ${request_id}`);
      return;
    }
    if (caller_metadata.tenant_id !== tenant_id) {
      console.error(`[precruise:batch-result] tenant mismatch for request ${request_id}`);
      return;
    }
    const { booking_id, phase, expected_contact_id, expected_contact_email } = caller_metadata;
    const svc = createServiceRoleClient();

    // Recover a provider success before parsing or regenerating. The batch
    // completion may itself be a replay after local effects committed.
    const { data: existingRaw } = await svc
      .from("pre_cruise_email_content")
      .select("id, sent_at, send_claimed_at, generated_content, content_context_hash")
      .eq("booking_id", booking_id)
      .eq("tenant_id", tenant_id)
      .eq("email_phase", phase)
      .maybeSingle();
    const existing = existingRaw as ExistingPrecruiseContent | null;
    const recovery = existing
      ? await recoverExistingPrecruiseSend({ svc, existing, tenantId: tenant_id, bookingId: booking_id, phase })
      : { status: "missing" as const };
    if (recovery.status === "sent") {
      return;
    }
    if (
      recovery.status === "queued"
      && recovery.providerAttemptState === "ambiguous"
      && recovery.providerFirstAttemptAt
    ) {
      await resumeStartedPrecruiseOutbox({
        svc,
        existing: existing!,
        tenantId: tenant_id,
        bookingId: booking_id,
        phase,
        providerFirstAttemptAt: recovery.providerFirstAttemptAt,
      });
      return;
    }

    const emailCtx = await loadEmailContext({ svc, booking_id, tenant_id, phase });
    if (!emailCtx) {
      if (recovery.status === "queued") {
        await abandonRecoveredPrecruiseOutbox({ svc, existing: existing!, tenantId: tenant_id, bookingId: booking_id, phase });
      }
      return;
    }
    if (
      expected_contact_id && expected_contact_email &&
      (emailCtx.booking.primary_contact_id !== expected_contact_id ||
        normalizeEmail(emailCtx.toEmail) !== normalizeEmail(expected_contact_email))
    ) {
      if (recovery.status === "queued") {
        await abandonRecoveredPrecruiseOutbox({ svc, existing: existing!, tenantId: tenant_id, bookingId: booking_id, phase });
      }
      console.info(`[precruise:batch-result] reviewed recipient changed: booking=${booking_id} phase=${phase}`);
      return;
    }
    const contentContextFingerprint = fingerprintEmailContext(emailCtx);
    if (
      recovery.status === "queued" &&
      existing?.generated_content &&
      existing.content_context_hash === contentContextFingerprint
    ) {
      await buildAndSend({ svc, phase, emailCtx, contentId: existing.id });
      return;
    }
    if (recovery.status === "queued") {
      const canRegenerate = await abandonRecoveredPrecruiseOutbox({
        svc,
        existing: existing!,
        tenantId: tenant_id,
        bookingId: booking_id,
        phase,
      });
      if (!canRegenerate) return;
    }

    // Parse the schema-constrained JSON (see parseStructuredJson for why
    // anything non-bare-JSON is rejected rather than sliced).
    const parsedGeneratedContent = parseStructuredJson(result_text);
    if (!parsedGeneratedContent) {
      console.error(`[precruise:batch-result] failed to parse JSON for booking=${booking_id} phase=${phase}`);
      return;
    }

    if (caller_metadata.content_context_hash !== contentContextFingerprint) {
      if (existing?.send_claimed_at) {
        console.info(`[precruise:batch-result] context changed after send claim: booking=${booking_id} phase=${phase}`);
        return;
      }
      await step.run(
        `reenqueue-batch:${phase}:${contentContextFingerprint}`,
        () => enqueuePrecruiseBatchGeneration({
          svc,
          booking_id,
          tenant_id,
          phase,
          emailCtx,
          emailCtxId: existing?.id ?? null,
          contentContextFingerprint,
          ...(expected_contact_id ? { expectedContactId: expected_contact_id } : {}),
          ...(expected_contact_email ? { expectedContactEmail: expected_contact_email } : {}),
        }),
      );
      console.info(`[precruise:batch-result] context changed; regenerated booking=${booking_id} phase=${phase}`);
      return;
    }

    // Insert the generated_content row (or update if already exists from
    // a partial prior run).
    let contentId: string | undefined = existing?.id;
    let contentWritten = false;
    if (!contentId) {
      const { data: inserted, error: insertError } = await svc
        .from("pre_cruise_email_content")
        .insert({
          tenant_id,
          booking_id,
          contact_id: emailCtx.booking.primary_contact_id!,
          email_phase: phase,
          generated_content: parsedGeneratedContent,
          content_context_hash: contentContextFingerprint,
          companion_page_url: caller_metadata.companion_page_url,
        })
        .select("id")
        .single();
      if (insertError?.code === "23505") {
        // #1582: duplicate-event race — another run already claimed
        // (booking_id, email_phase). Let that run own the send.
        console.info(`[precruise:batch-result] duplicate insert race, skipping send: booking=${booking_id} phase=${phase}`);
        return;
      }
      if (insertError) throw new SupabaseMutationError("pre_cruise_email_content.insert", insertError);
      contentId = (inserted as { id: string } | null)?.id;
      contentWritten = true;
    } else if (!(
      existing?.generated_content &&
      existing.content_context_hash === contentContextFingerprint
    )) {
      let updateQuery = svc
        .from("pre_cruise_email_content")
        .update({
          contact_id: emailCtx.booking.primary_contact_id!,
          generated_content: parsedGeneratedContent,
          content_context_hash: contentContextFingerprint,
          companion_page_url: emailCtx.companionPageUrl,
          generated_at: new Date().toISOString(),
        })
        .eq("id", contentId)
        .eq("tenant_id", tenant_id)
        .is("sent_at", null)
        .is("send_claimed_at", null);
      updateQuery = existing?.content_context_hash === null || existing?.content_context_hash === undefined
        ? updateQuery.is("content_context_hash", null)
        : updateQuery.eq("content_context_hash", existing.content_context_hash);
      const updated = await safeAwait(
        updateQuery.select("id"),
        "pre_cruise_email_content.update.generated",
      );
      if ((updated as Array<{ id: string }> | null)?.length !== 1) {
        console.info(`[precruise:batch-result] content changed while regenerating, skipping: booking=${booking_id} phase=${phase}`);
        return;
      }
      contentWritten = true;
    }
    if (contentWritten) revalidateCompanionContent(booking_id, phase);

    if (!contentId) throw new Error("pre-cruise content row did not return an id");
    await buildAndSend({
      svc,
      phase,
      emailCtx,
      contentId,
    });
  },
);

// ── Shared helpers ─────────────────────────────────────────────────────

interface EmailCtx {
  booking: {
    id: string;
    status: string;
    user_id?: string;
    primary_contact_id?: string | null;
    group_booking_id?: string;
    cruise_line?: string | null;
    ship_name?: string | null;
    sailing_date?: string | null;
    departure_port?: string | null;
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
  };
  branding: {
    logo_url?: string;
    primary_color?: string;
    secondary_color?: string;
    accent_color?: string;
    slogan?: string;
    email_send_pattern?: string;
    tenant_resend_api_key_encrypted?: string;
    email_from_address?: string;
    email_from_name?: string;
    email_from_domain?: string;
    email_from_domain_verified_at?: string;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function fingerprintEmailContext(ctx: EmailCtx): string {
  return createHash("sha256")
    .update(JSON.stringify({
      contact_id: ctx.booking.primary_contact_id,
      recipient_email: normalizeEmail(ctx.toEmail),
      customer_name: ctx.customerName,
      cruise_line: ctx.cruiseLine,
      ship_name: ctx.shipName,
      sailing_date: ctx.sailingDate,
      departure_port: ctx.departurePort ?? null,
      ports: ctx.ports,
    }))
    .digest("hex");
}

function precruiseIdempotencyKey(bookingId: string, phase: Phase): string {
  return `pre_cruise:${bookingId}:${phase}`;
}

async function recoverExistingPrecruiseSend(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  existing: ExistingPrecruiseContent;
  tenantId: string;
  bookingId: string;
  phase: Phase;
}): Promise<{
  status: "sent" | "missing" | "queued";
  providerFirstAttemptAt?: string | null;
  providerAttemptState?: "unstarted" | "ambiguous" | "rejected" | null;
}> {
  const recovery = await recoverIdempotentEmail({
    db: args.svc,
    tenantId: args.tenantId,
    idempotencyKey: precruiseIdempotencyKey(args.bookingId, args.phase),
  });

  if (recovery.status === "sent") {
    if (!args.existing.sent_at) {
      await finalizeContentAsSent({
        svc: args.svc,
        contentId: args.existing.id,
        tenantId: args.tenantId,
        sentAt: recovery.sent_at ?? new Date().toISOString(),
      });
    }
    console.info(`[precruise] recovered sent email: booking=${args.bookingId} phase=${args.phase}`);
    return { status: "sent" };
  }

  // A stamped companion row is terminal even if its historical logical log is
  // missing or incomplete. The shared recovery above still gets first chance
  // to heal any durable keyed effects, but this path must never re-deliver.
  if (args.existing.sent_at) {
    console.info(`[precruise] already sent: booking=${args.bookingId} phase=${args.phase}`);
    return { status: "sent" };
  }

  if (recovery.status === "missing") return { status: "missing" };

  return {
    status: "queued",
    providerFirstAttemptAt: recovery.provider_first_attempt_at ?? null,
    providerAttemptState: recovery.provider_attempt_state ?? null,
  };
}

async function abandonRecoveredPrecruiseOutbox(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  existing: ExistingPrecruiseContent;
  tenantId: string;
  bookingId: string;
  phase: Phase;
}): Promise<boolean> {
  const abandoned = await abandonUnstartedIdempotentEmail({
    db: args.svc,
    tenantId: args.tenantId,
    idempotencyKey: precruiseIdempotencyKey(args.bookingId, args.phase),
  });
  if (abandoned) {
    if (args.existing.send_claimed_at) {
      await releaseContentClaim({
        svc: args.svc,
        contentId: args.existing.id,
        tenantId: args.tenantId,
        claimedAt: args.existing.send_claimed_at,
      });
      args.existing.send_claimed_at = null;
    }
    return true;
  }

  const recovery = await recoverExistingPrecruiseSend(args);
  if (recovery.status === "sent") return false;
  if (
    recovery.status === "queued"
    && recovery.providerAttemptState === "ambiguous"
    && recovery.providerFirstAttemptAt
  ) {
    await resumeStartedPrecruiseOutbox({
      svc: args.svc,
      existing: args.existing,
      tenantId: args.tenantId,
      bookingId: args.bookingId,
      phase: args.phase,
      providerFirstAttemptAt: recovery.providerFirstAttemptAt,
    });
    return false;
  }
  if (recovery.status === "missing") {
    if (!args.existing.send_claimed_at) return true;
    await releaseContentClaim({
      svc: args.svc,
      contentId: args.existing.id,
      tenantId: args.tenantId,
      claimedAt: args.existing.send_claimed_at,
    });
    args.existing.send_claimed_at = null;
    return true;
  }

  throw new Error(
    `[precruise] outbox abandon lost CAS without authoritative state booking=${args.bookingId} phase=${args.phase}`,
  );
}

async function enqueuePrecruiseBatchGeneration(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  booking_id: string;
  tenant_id: string;
  phase: Phase;
  emailCtx: EmailCtx;
  emailCtxId: string | null;
  contentContextFingerprint: string;
  expectedContactId?: string;
  expectedContactEmail?: string;
}): Promise<void> {
  const prompt = buildBatchedPrompt(args.phase, args.emailCtx);
  await enqueueBatchRequest({
    tenant_id: args.tenant_id,
    purpose: "precruise_generation",
    request_params: {
      model: HAIKU_MODEL,
      max_tokens: 2048,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      output_config: {
        format: { type: "json_schema", schema: PRECRUISE_OUTPUT_SCHEMAS[args.phase] },
      },
    },
    caller_metadata: {
      booking_id: args.booking_id,
      tenant_id: args.tenant_id,
      phase: args.phase,
      email_ctx_id: args.emailCtxId,
      companion_page_url: args.emailCtx.companionPageUrl,
      content_context_hash: args.contentContextFingerprint,
      ...(args.expectedContactId ? { expected_contact_id: args.expectedContactId } : {}),
      ...(args.expectedContactEmail ? { expected_contact_email: args.expectedContactEmail } : {}),
    },
    db: args.svc,
  });
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
    // #1190: bookings has no customer_name/passenger_contact_email/group_id —
    // the recipient comes from the linked contact, and the FK is group_booking_id.
    .select(
      "id, tenant_id, status, group_booking_id, user_id, primary_contact_id, cruise_line, ship_name, sailing_date, departure_port, groups(cruise_line, ship_name, sailing_date, departure_port)",
    )
    .eq("id", booking_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (!bookingRaw) {
    console.error(`[precruise] booking not found: ${booking_id}`);
    return null;
  }
  const booking = bookingRaw as EmailCtx["booking"];
  if (booking.status !== "confirmed") {
    console.info(`[precruise] booking is no longer confirmed: ${booking_id}`);
    return null;
  }

  // #1190: recipient name + email come from the booking's primary contact.
  if (!booking.primary_contact_id) {
    console.warn(`[precruise] no primary contact for booking ${booking_id}`);
    return null;
  }
  const { data: contactRaw } = await svc
    .from("contacts")
    .select("first_name, email")
    .eq("id", booking.primary_contact_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const contact = contactRaw as { first_name?: string | null; email?: string | null } | null;
  const toEmail = contact?.email ?? undefined;
  if (!toEmail) {
    console.warn(`[precruise] no contact email for booking ${booking_id}`);
    return null;
  }

  const { data: tenantRaw } = await svc
    .from("tenants")
    // #1190: email_* / send-pattern / resend-key live on tenant_branding.
    .select("id, legal_name, mailing_address")
    .eq("id", tenant_id)
    .maybeSingle();
  const tenant = tenantRaw as EmailCtx["tenant"] | null;
  if (!tenant) {
    console.error(`[precruise] tenant not found: ${tenant_id}`);
    return null;
  }

  const { data: brandingRaw } = await svc
    .from("tenant_branding")
    // #1935 — shared column list across all five branding-reading crons so
    // a verified custom domain (email_from_domain*) can't drift out again.
    .select(TENANT_BRANDING_COLUMNS)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const branding = (brandingRaw as EmailCtx["branding"] | null) ?? {};

  // #1190: first name only (per product decision) from the booking's contact.
  const customerName = contact?.first_name ?? "Traveler";
  const shipName = booking.ship_name ?? booking.groups?.ship_name ?? "your ship";
  const cruiseLine = booking.cruise_line ?? booking.groups?.cruise_line ?? "";
  const sailingDate = booking.sailing_date ?? booking.groups?.sailing_date ?? "";
  // Per-stop itinerary (ports of call) isn't captured yet — the DIY
  // CruiseMapper scraper has no sailing parser (#485). Until that lands,
  // the ports list is empty and the destination-image / multi-day-forecast
  // wiring (#487) stays inert. The departure port DOES exist on groups.
  const ports: string[] = [];
  const departurePort = booking.departure_port ?? booking.groups?.departure_port;

  const companionToken = await signCompanionToken({ booking_id, phase });
  const baseUrl = process.env.PLATFORM_PRIMARY_DOMAIN
    ? `https://${tenant_id}.${process.env.PLATFORM_PRIMARY_DOMAIN}`
    : "https://app.ai-travelconcierge.com";
  const companionPageUrl = `${baseUrl}/companion/${companionToken}`;

  const unsubToken = await signUnsubscribeToken({ email: toEmail, tenant_id, category: "pre_cruise" });
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
    tenant_business_address: formatMailingAddress(tenant.mailing_address),
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

async function emailContextStillCurrent(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  emailCtx: EmailCtx;
}): Promise<boolean> {
  const { svc, emailCtx } = args;
  const { data: bookingData, error: bookingError } = await svc
    .from("bookings")
    .select(
      "status, primary_contact_id, cruise_line, ship_name, sailing_date, departure_port, groups(cruise_line, ship_name, sailing_date, departure_port), contacts!primary_contact_id(tenant_id, first_name, email)",
    )
    .eq("id", emailCtx.booking.id)
    .eq("tenant_id", emailCtx.tenant.id)
    .maybeSingle();
  if (bookingError) {
    throw new SupabaseMutationError("precruise.final_state.booking_read", bookingError);
  }
  const booking = bookingData as {
    status: string;
    primary_contact_id: string | null;
    cruise_line: string | null;
    ship_name: string | null;
    sailing_date: string | null;
    departure_port: string | null;
    contacts: Array<{
      tenant_id: string;
      first_name: string | null;
      email: string | null;
    }> | {
      tenant_id: string;
      first_name: string | null;
      email: string | null;
    } | null;
    groups: Array<{
      cruise_line: string | null;
      ship_name: string | null;
      sailing_date: string | null;
      departure_port: string | null;
    }> | {
      cruise_line: string | null;
      ship_name: string | null;
      sailing_date: string | null;
      departure_port: string | null;
    } | null;
  } | null;
  if (
    booking?.status !== "confirmed" ||
    booking.primary_contact_id !== emailCtx.booking.primary_contact_id
  ) {
    console.info(`[precruise] final booking state changed: booking=${emailCtx.booking.id}`);
    return false;
  }

  const contact = Array.isArray(booking.contacts) ? booking.contacts[0] : booking.contacts;
  const groups = Array.isArray(booking.groups) ? booking.groups[0] : booking.groups;
  if (
    contact?.tenant_id !== emailCtx.tenant.id ||
    !contact?.email ||
    normalizeEmail(contact.email) !== normalizeEmail(emailCtx.toEmail) ||
    (contact.first_name ?? "Traveler") !== emailCtx.customerName ||
    (booking.cruise_line ?? groups?.cruise_line ?? "") !== emailCtx.cruiseLine ||
    (booking.ship_name ?? groups?.ship_name ?? "your ship") !== emailCtx.shipName ||
    (booking.sailing_date ?? groups?.sailing_date ?? "") !== emailCtx.sailingDate ||
    (booking.departure_port ?? groups?.departure_port ?? undefined) !== emailCtx.departurePort
  ) {
    console.info(`[precruise] final email context changed: booking=${emailCtx.booking.id}`);
    return false;
  }
  return true;
}

function providerReplayWindowExpired(firstAttemptAt: string | null): boolean {
  if (!firstAttemptAt) return false;
  const firstAttemptMs = Date.parse(firstAttemptAt);
  const elapsed = Date.now() - firstAttemptMs;
  return !Number.isFinite(firstAttemptMs) || elapsed < 0 || elapsed >= PROVIDER_REPLAY_CUTOFF_MS;
}

async function claimContentForSend(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  contentId: string;
  tenantId: string;
}): Promise<{
  claimedAt: string;
  contentContextHash: string | null;
  generatedContent: Record<string, unknown>;
} | null> {
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - SEND_CLAIM_TTL_MS).toISOString();
  const rows = await safeAwait(
    args.svc
      .from("pre_cruise_email_content")
      .update({ send_claimed_at: claimedAt })
      .eq("id", args.contentId)
      .eq("tenant_id", args.tenantId)
      .is("sent_at", null)
      .or(`send_claimed_at.is.null,send_claimed_at.lt.${staleBefore}`)
      .select("send_claimed_at, content_context_hash, generated_content"),
    "pre_cruise_email_content.claim.send",
  );
  const claimed = (rows as Array<{
    send_claimed_at: string;
    content_context_hash: string | null;
    generated_content: Record<string, unknown>;
  }> | null)?.[0];
  return claimed ? {
    claimedAt: claimed.send_claimed_at,
    contentContextHash: claimed.content_context_hash,
    generatedContent: claimed.generated_content,
  } : null;
}

async function releaseContentClaim(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  contentId: string;
  tenantId: string;
  claimedAt: string;
}): Promise<void> {
  await safeAwaitRowCount(
    args.svc
      .from("pre_cruise_email_content")
      .update({ send_claimed_at: null })
      .eq("id", args.contentId)
      .eq("tenant_id", args.tenantId)
      .eq("send_claimed_at", args.claimedAt)
      .select("id"),
    "pre_cruise_email_content.release.send_claim",
    1,
  );
}

async function finalizeContentAsSent(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  contentId: string;
  tenantId: string;
  sentAt: string;
  claimedAt?: string;
}): Promise<void> {
  let updateQuery = args.svc
    .from("pre_cruise_email_content")
    .update({ sent_at: args.sentAt, send_claimed_at: null })
    .eq("id", args.contentId)
    .eq("tenant_id", args.tenantId)
    .is("sent_at", null);
  if (args.claimedAt) updateQuery = updateQuery.eq("send_claimed_at", args.claimedAt);
  const rows = await safeAwait(
    updateQuery.select("id"),
    "pre_cruise_email_content.finalize.sent_at",
  );
  if ((rows as Array<{ id: string }> | null)?.length === 1) return;

  const current = await safeAwait(
    args.svc
      .from("pre_cruise_email_content")
      .select("sent_at")
      .eq("id", args.contentId)
      .eq("tenant_id", args.tenantId)
      .limit(1)
      .maybeSingle(),
    "pre_cruise_email_content.verify.sent_at",
  ) as { sent_at: string | null } | null;
  if (!current?.sent_at) {
    throw new Error("pre-cruise content finalization lost its claim");
  }
}

async function loadTenantForOutboxReplay(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  tenantId: string;
}): Promise<SendEmailInput["tenant"]> {
  const tenant = await safeAwait(
    args.svc
      .from("tenants")
      .select("id, legal_name, mailing_address")
      .eq("id", args.tenantId)
      .limit(1)
      .maybeSingle(),
    "precruise.replay.tenant",
  ) as { id: string; legal_name: string | null; mailing_address: string | null } | null;
  if (!tenant) throw new Error("pre-cruise replay tenant not found");

  const branding = await safeAwait(
    args.svc
      .from("tenant_branding")
      .select(TENANT_BRANDING_COLUMNS)
      .eq("tenant_id", args.tenantId)
      .limit(1)
      .maybeSingle(),
    "precruise.replay.branding",
  ) as EmailCtx["branding"] | null;

  return {
    id: tenant.id,
    legal_name: tenant.legal_name ?? "Travel Agency",
    mailing_address: tenant.mailing_address,
    email_send_pattern: (branding?.email_send_pattern ?? "platform_resend") as
      | "platform_resend"
      | "tenant_resend",
    tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
    email_from_address: branding?.email_from_address ?? null,
    email_from_name: branding?.email_from_name ?? null,
    email_from_domain: branding?.email_from_domain ?? null,
    email_from_domain_verified_at: branding?.email_from_domain_verified_at ?? null,
  };
}

async function resumeStartedPrecruiseOutbox(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  existing: ExistingPrecruiseContent;
  tenantId: string;
  bookingId: string;
  phase: Phase;
  providerFirstAttemptAt: string;
}): Promise<void> {
  const claim = await claimContentForSend({
    svc: args.svc,
    contentId: args.existing.id,
    tenantId: args.tenantId,
  });
  if (!claim) {
    console.info(`[precruise] replay already claimed: booking=${args.bookingId} phase=${args.phase}`);
    return;
  }
  const { claimedAt } = claim;
  if (providerReplayWindowExpired(args.providerFirstAttemptAt)) {
    await releaseContentClaim({
      svc: args.svc,
      contentId: args.existing.id,
      tenantId: args.tenantId,
      claimedAt,
    });
    throw new Error(
      `[precruise] provider replay window expired; operator reconciliation required: booking=${args.bookingId} phase=${args.phase}`,
    );
  }

  const tenant = await loadTenantForOutboxReplay({ svc: args.svc, tenantId: args.tenantId });
  let result;
  try {
    result = await resumeIdempotentEmail({
      db: args.svc,
      tenant,
      idempotencyKey: precruiseIdempotencyKey(args.bookingId, args.phase),
      beforeDispatch: async ({ providerReplay }) => {
        return providerReplay
          ? { allowed: true }
          : { allowed: false, reason: "provider_replay_state_missing" };
      },
    });
  } catch (error) {
    await releaseContentClaim({
      svc: args.svc,
      contentId: args.existing.id,
      tenantId: args.tenantId,
      claimedAt,
    });
    throw error;
  }

  if (result.status === "sent") {
    await finalizeContentAsSent({
      svc: args.svc,
      contentId: args.existing.id,
      tenantId: args.tenantId,
      sentAt: new Date().toISOString(),
      claimedAt,
    });
    return;
  }

  await releaseContentClaim({
    svc: args.svc,
    contentId: args.existing.id,
    tenantId: args.tenantId,
    claimedAt,
  });
  if (result.status === "failed") {
    throw new Error(
      `[precruise] replay failed booking=${args.bookingId} phase=${args.phase} reason=${result.reason ?? "unknown"}`,
    );
  }
}

async function buildAndSend(args: {
  svc: ReturnType<typeof createServiceRoleClient>;
  phase: Phase;
  emailCtx: EmailCtx;
  contentId: string;
}): Promise<void> {
  const { svc, phase, emailCtx, contentId } = args;

  const claim = await claimContentForSend({
    svc,
    contentId,
    tenantId: emailCtx.tenant.id,
  });
  if (!claim) {
    console.info(`[precruise] send already claimed: booking=${emailCtx.booking.id} phase=${phase}`);
    return;
  }
  const { claimedAt, contentContextHash, generatedContent } = claim;

  if (contentContextHash !== fingerprintEmailContext(emailCtx)) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    console.info(`[precruise] claimed content context is stale: booking=${emailCtx.booking.id} phase=${phase}`);
    return;
  }

  let paymentCheck: Awaited<ReturnType<typeof assertTenantStillPayingById>>;
  try {
    paymentCheck = await assertTenantStillPayingById(svc, emailCtx.tenant.id);
  } catch (error) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    throw error;
  }
  if (!paymentCheck.ok) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    console.info(`[precruise] tenant became ineligible before send: booking=${emailCtx.booking.id} phase=${phase}`);
    return;
  }

  let contextIsCurrent: boolean;
  try {
    contextIsCurrent = await emailContextStillCurrent({ svc, emailCtx });
  } catch (error) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    throw error;
  }
  if (!contextIsCurrent) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    return;
  }

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

  // §23.4 / #487 — fetch itinerary from RAG for destination image + weather forecast.
  // Null-safe: getSailingItinerary returns null when RAG_SERVICE_URL is unset or the
  // sailing isn't indexed yet. All downstream consumers handle null gracefully.
  const itin = await getSailingItinerary({
    cruise_line: emailCtx.cruiseLine,
    ship_name: emailCtx.shipName,
    sailing_date: emailCtx.sailingDate,
  });

  const region = resolveDestinationRegion({
    cruisemapper_region: itin?.cruisemapper_region ?? null,
    ports_of_call: itin?.ports_of_call ?? [],
  });
  const destinationImage = getDestinationImage(region);

  let cruiseForecast: DailyForecast[] | null = null;
  if ((phase === "t_7" || phase === "t_1") && itin?.days && itin.days.length > 0) {
    const itinDays: ItineraryDay[] = await Promise.all(
      itin.days.map(async (d) => {
        if (!d.port_name) return { ...d, latitude: null, longitude: null };
        const port = await lookupPortByName(svc, d.port_name);
        return { ...d, latitude: port?.latitude ?? null, longitude: port?.longitude ?? null };
      }),
    );
    const stops = interpolateSeaDays(itinDays);
    if (stops.length > 0) {
      cruiseForecast = await getCruiseForecast(stops);
    }
  }

  // #963 — tenant subject/body override → platform default. A failed
  // override read or render throws (fail loud → Inngest retry); we never
  // silently fall back or send an empty body.
  //
  // #975 — ai_content carries the flattened AI sections so an override body
  // can place {{ai_content}} instead of replacing the AI content entirely.
  // Substitution happens before bodyTextToHtml, so the value is escaped
  // like any tenant-typed text.
  const resolved = await resolveEmailContent({
    db: svc,
    tenant_id: emailCtx.tenant.id,
    email_type: `pre_cruise_${phase}`,
    variables: {
      customer_name: emailCtx.customerName,
      ship_name: emailCtx.shipName,
      cruise_line: emailCtx.cruiseLine,
      sailing_date: emailCtx.sailingDate,
      companion_page_url: emailCtx.companionPageUrl,
      ai_content: precruiseAiContentText(phase, generatedContent),
    },
  });
  const subject = resolved.subject;

  const html =
    resolved.overrideBodyText !== null
      ? await renderOverrideBodyInLayout(emailCtx.layoutProps, resolved.overrideBodyText)
      : (
          await buildEmail(phase, {
            layoutProps: emailCtx.layoutProps,
            customerName: emailCtx.customerName,
            shipName: emailCtx.shipName,
            cruiseLine: emailCtx.cruiseLine,
            sailingDate: emailCtx.sailingDate,
            ports: emailCtx.ports,
            generatedContent,
            companionPageUrl: emailCtx.companionPageUrl,
            portInfo,
            destinationImage,
            cruiseForecast,
          })
        ).html;

  const tenantInput: SendEmailInput["tenant"] = {
    id: emailCtx.tenant.id,
    legal_name: emailCtx.tenant.legal_name ?? "Travel Agency",
    mailing_address: emailCtx.tenant.mailing_address ?? null,
    // #1190: email send config comes from tenant_branding.
    email_send_pattern: (emailCtx.branding.email_send_pattern ?? "platform_resend") as
      | "platform_resend"
      | "tenant_resend",
    tenant_resend_api_key_encrypted: emailCtx.branding.tenant_resend_api_key_encrypted ?? null,
    email_from_address: emailCtx.branding.email_from_address ?? null,
    email_from_name: emailCtx.branding.email_from_name ?? null,
    // #1935 — verified custom domain, now read alongside the rest of branding.
    email_from_domain: emailCtx.branding.email_from_domain ?? null,
    email_from_domain_verified_at: emailCtx.branding.email_from_domain_verified_at ?? null,
  };

  let result;
  try {
    result = await sendEmail({
      db: svc,
      tenant: tenantInput,
      to: emailCtx.toEmail,
      subject,
      template_id: `pre_cruise_${phase}`,
      category: "pre_cruise",
      html,
      idempotencyKey: precruiseIdempotencyKey(emailCtx.booking.id, phase),
      beforeDispatch: async ({ providerReplay }) => {
        if (!providerReplay) {
          const finalPaymentCheck = await assertTenantStillPayingById(svc, emailCtx.tenant.id);
          if (!finalPaymentCheck.ok) {
            return { allowed: false, reason: "tenant_not_paying" };
          }
          if (!await emailContextStillCurrent({ svc, emailCtx })) {
            return { allowed: false, reason: "email_context_changed" };
          }
        }
        return { allowed: true };
      },
      contact_id: emailCtx.booking.primary_contact_id!,
      related_booking_id: emailCtx.booking.id,
      ...(emailCtx.booking.user_id ? { user_id: emailCtx.booking.user_id } : {}),
      ...(emailCtx.booking.group_booking_id ? { related_group_id: emailCtx.booking.group_booking_id } : {}),
    });
  } catch (error) {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
    throw error;
  }

  if (result.status === "sent") {
    await finalizeContentAsSent({
      svc,
      contentId,
      tenantId: emailCtx.tenant.id,
      sentAt: new Date().toISOString(),
      claimedAt,
    });
  } else {
    await releaseContentClaim({ svc, contentId, tenantId: emailCtx.tenant.id, claimedAt });
  }

  console.info(
    `[precruise] booking=${emailCtx.booking.id} phase=${phase} status=${result.status}`,
  );

  // #1582: "failed" (Resend 5xx/timeout/misconfigured key) must fail loud so
  // Inngest retries the run — the row stays with sent_at null and the
  // scheduler's sent_at-based dedup will pick this booking back up rather
  // than skipping it forever. "suppressed" and "rate_limited" are terminal
  // policy decisions, not transient errors, and must not retry.
  if (result.status === "failed") {
    throw new Error(
      `[precruise] send failed booking=${emailCtx.booking.id} phase=${phase} reason=${result.reason ?? "unknown"}`,
    );
  }
}

// #2009 — provider-constrained structured output for the batched path.
// The API's output_config.format (json_schema) guarantees the response is
// bare, schema-valid JSON, replacing the old "Return ONLY a JSON object"
// prompt-begging + fence/brace slicing in the consumer. Field descriptions
// carry the per-field content guidance the user prompt used to embed — the
// schema is the single source of truth for the output shape.
//
// Constraints (Anthropic structured outputs): every object needs
// additionalProperties:false and a full `required` list; no min/max length
// constraints. Keys per phase MUST stay in sync with what buildEmail and
// precruiseAiContentText consume — pinned by
// test/unit/ai/precruise-output-schemas.test.ts.
function strField(description: string): Record<string, unknown> {
  return { type: "string", description };
}
function strListField(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}
function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export const PRECRUISE_OUTPUT_SCHEMAS: Record<Phase, Record<string, unknown>> = {
  t_90: objectSchema({
    documentation_reminder: strField("2 sentences — passport validity, travel insurance, visa check"),
    destination_teaser: strField("2-3 sentences — exciting preview of the ports"),
    must_do_experiences: strListField("Exactly 3 must-do experiences at these ports"),
    did_you_know: strField("1-2 sentences — fascinating fact about cruising or the ports"),
    suggested_reads: strListField("Always an empty array"),
  }),
  t_30: objectSchema({
    reservation_reminders: strListField(
      'Exactly: ["Specialty dining reservations", "Shore excursions", "Spa appointments"]',
    ),
    checkin_window: strField("2 sentences — when online check-in opens and why to do it early"),
    final_payment_note: { type: "null", description: "Always null" },
    personalized_recommendations: strListField(
      "Exactly 3 personalized recommendations (specialty dining, excursions, spa)",
    ),
    specialty_experiences: strListField(
      "Exactly 3 distinctive onboard or port experiences worth reserving, without duplicating the personalized recommendations",
    ),
    pack_inspiration: strField("2-3 sentences — packing inspiration / style tips for this cruise"),
  }),
  t_7: objectSchema({
    packing_checklist: strListField("Exactly 8 essential packing items"),
    ship_highlights: strListField("Exactly 3 ship highlights"),
    cruise_line_tips: strListField("Exactly 3 cruise-line-specific tips"),
    embarkation_advice: strField("2-3 sentences — what to expect on embarkation day"),
    first_day_inspiration: strField("2 sentences — the magic of the first day aboard"),
  }),
  // T-1 should never hit the batched path (scheduler skips it) but defining
  // the schema keeps the consumer DRY-safe if the discriminator slips.
  t_1: objectSchema({
    first_port_preview: strField("2 sentences — exciting preview of the first port of call"),
    day_of_expectations: strField("2-3 sentences — check-in time, muster drill, sail-away"),
  }),
};

function buildBatchedPrompt(
  phase: Phase,
  ctx: EmailCtx,
): { system: string; user: string } {
  // One structured-JSON request per email — replaces the 4-5 separate
  // direct-path Haiku calls. Lower token cost AND cleaner consumer. The
  // output shape and per-field guidance live in PRECRUISE_OUTPUT_SCHEMAS.
  const system = [
    `You are a travel concierge generating pre-cruise email content for ${ctx.customerName}.`,
    `The cruise is on ${ctx.shipName} (${ctx.cruiseLine}), sailing ${ctx.sailingDate}.`,
    `Ports: ${ctx.ports.join(", ") || "TBD"}.`,
    "",
    "Content is concise, enthusiastic, and practical.",
  ].join("\n");
  const labels: Record<Phase, string> = { t_90: "T-90", t_30: "T-30", t_7: "T-7", t_1: "T-1" };
  return { system, user: `Generate the ${labels[phase]} pre-cruise email content.` };
}

// #975 — flatten the per-phase AI sections to plain text for the
// {{ai_content}} variable in tenant body overrides. Blank lines separate
// sections so bodyTextToHtml renders them as paragraphs; list items keep a
// "• " prefix (escape-safe — bodyTextToHtml escapes markup, not bullets).
// Exported for tests: every AI field the default email renders must appear
// here, or an override using {{ai_content}} silently loses content.
export function precruiseAiContentText(
  phase: Phase,
  c: Record<string, unknown>,
): string {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown): string =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => `• ${x.trim()}`)
          .join("\n")
      : "";

  let sections: string[];
  switch (phase) {
    case "t_90":
      sections = [
        str(c.documentation_reminder),
        str(c.destination_teaser),
        list(c.must_do_experiences),
        str(c.did_you_know),
      ];
      break;
    case "t_30":
      sections = [
        list(c.reservation_reminders),
        str(c.checkin_window),
        str(c.final_payment_note),
        list(c.personalized_recommendations),
        list(c.specialty_experiences),
        str(c.pack_inspiration),
      ];
      break;
    case "t_7":
      sections = [
        list(c.packing_checklist),
        list(c.ship_highlights),
        list(c.cruise_line_tips),
        str(c.embarkation_advice),
        str(c.first_day_inspiration),
      ];
      break;
    case "t_1":
      sections = [str(c.first_port_preview), str(c.day_of_expectations)];
      break;
  }
  return sections.filter((s) => s.length > 0).join("\n\n");
}

function parseStructuredJson(text: string): Record<string, unknown> | null {
  // #2009 — the batched request is schema-constrained (output_config.format),
  // so a successful result is bare JSON. Anything else — a refusal, a
  // max_tokens truncation, or a pre-#2009 in-flight row — is rejected
  // outright rather than fence-stripped or brace-sliced (slicing could
  // silently accept a truncated object). A rejected row is never marked
  // sent, so the daily scheduler's sent_at dedup re-fires the booking and
  // it re-enqueues with the schema constraint.
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — non-JSON result
  }
  return null;
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
      // #1792 — all four prompts are independent Haiku calls (none reads
      // another's output); fan out together instead of a trailing solo await.
      const [checkin, packInspiration, recs, experiences] = await Promise.all([
        haikuGenerate(tenant_id, sys, "Explain the online check-in window and why to do it early, in 2 sentences."),
        haikuGenerate(tenant_id, sys, "Give packing inspiration / style tips for this cruise, in 2-3 sentences."),
        haikuGenerate(tenant_id, sys, "List 3 personalized recommendations (specialty dining, excursions, spa) one per line, no bullet points."),
        haikuGenerate(tenant_id, sys, "List 3 distinctive onboard or port experiences worth reserving, one per line, no bullet points. Do not repeat the personalized dining, excursion, or spa recommendations."),
      ]);
      return {
        reservation_reminders: ["Specialty dining reservations", "Shore excursions", "Spa appointments"],
        checkin_window: checkin,
        final_payment_note: null,
        personalized_recommendations: recs.split("\n").filter(Boolean).slice(0, 3),
        specialty_experiences: experiences.split("\n").filter(Boolean).slice(0, 3),
        pack_inspiration: packInspiration,
      };
    }
    case "t_7": {
      // #1792 — all five prompts are independent Haiku calls; fan out
      // together instead of two trailing solo awaits after the batch.
      const [packingRaw, embarkation, firstDay, highlights, tips] = await Promise.all([
        haikuGenerate(tenant_id, sys, "Generate a concise packing checklist of 8 essential items, one per line, no bullet points."),
        haikuGenerate(tenant_id, sys, "Describe what to expect on embarkation day in 2-3 sentences."),
        haikuGenerate(tenant_id, sys, "Describe the magic of the first day aboard in 2 sentences."),
        haikuGenerate(tenant_id, sys, "List 3 ship highlights one per line, no bullet points."),
        haikuGenerate(tenant_id, sys, "Give 3 cruise-line-specific tips one per line, no bullet points."),
      ]);
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
    destinationImage: DestinationImage | null;
    cruiseForecast: DailyForecast[] | null;
  },
): Promise<{ html: string }> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { layoutProps, customerName, shipName, cruiseLine, sailingDate, ports, generatedContent: c, companionPageUrl, portInfo, destinationImage, cruiseForecast } = ctx;

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
        destination_image: destinationImage,
        companion_page_url: companionPageUrl,
      };
      return { html: renderToStaticMarkup(React.createElement(PreCruiseT90, props)) };
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
        specialty_experiences: (c.specialty_experiences as string[]) ?? [],
        pack_inspiration: (c.pack_inspiration as string) ?? "",
        companion_page_url: companionPageUrl,
        destination_image: destinationImage,
      };
      return { html: renderToStaticMarkup(React.createElement(PreCruiseT30, props)) };
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
        destination_image: destinationImage,
        cruise_forecast: cruiseForecast,
      };
      return { html: renderToStaticMarkup(React.createElement(PreCruiseT7, props)) };
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
        destination_image: destinationImage,
        cruise_forecast: cruiseForecast,
      };
      return { html: renderToStaticMarkup(React.createElement(PreCruiseT1, props)) };
    }
  }
}

// Re-export parseStructuredJson, buildEmail, and buildAndSend for tests.
export { parseStructuredJson, buildEmail, buildAndSend };
