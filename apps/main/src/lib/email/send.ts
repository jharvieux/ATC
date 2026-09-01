// §23.1 / §23.6 / §23.7 — Unified email send helper.
//
// Unkeyed sends check policy, call Resend, then write their legacy log row.
// Keyed sends check policy, prepare a durable outbox before Resend, and
// atomically finalize the log, retry content, and usage after provider success.
// Started keyed retries replay the stored provider request inside the provider's
// idempotency window; the caller owns any feature-specific reconciliation guard.
//
// Rendering React email templates to HTML is the caller's responsibility.
// Callers must use a dynamic import for react-dom/server to avoid bundler
// issues with Next.js App Router API routes:
//   const { renderToStaticMarkup } = await import("react-dom/server");
//   const html = renderToStaticMarkup(jsx);
//
// Callers must pass a service-role SupabaseClient (db) — this function writes
// email_log and reads suppressions at the service level.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, createHmac } from "node:crypto";
import { checkRateLimit, type EmailCategory } from "./rate-limit";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { recordVendorFailure, recordVendorSuccess } from "@/lib/vendor-health/registry";
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementEmailSent } from "@/lib/abuse/counters";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";
import { safeAwait } from "@/lib/db/safe-mutation";

// #1935 — shared tenant_branding column projection for every cron/job that
// reads branding before sending mail. Two crons omitted email_from_domain /
// email_from_domain_verified_at, so a tenant with a verified custom domain
// got a different from-address depending on which cron sent — importing
// this constant instead of hand-writing the column list is what keeps them
// from drifting apart again.
export const TENANT_BRANDING_COLUMNS =
  "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
  "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
  "email_from_name, email_from_domain, email_from_domain_verified_at";

export interface SendEmailInput {
  db: SupabaseClient;
  tenant: {
    id: string;
    legal_name: string;
    mailing_address?: string | null;
    email_send_pattern: "platform_resend" | "tenant_resend";
    tenant_resend_api_key_encrypted?: string | null;
    email_from_address?: string | null;
    email_from_name?: string | null;
    // §16.4 — when a tenant has verified their own from-domain via the
    // /api/tenant/branding/email-domain/verify endpoint, prefer it for the
    // from address. email_from_domain_verified_at acts as the gate; until
    // verification succeeds the field is null and we fall back to the
    // platform default below. Both fields are optional — callers that
    // don't fetch them get the default behavior.
    email_from_domain?: string | null;
    email_from_domain_verified_at?: string | null;
  };
  to: string;
  subject: string;
  template_id: string;
  template_variables?: Record<string, unknown>;
  category: EmailCategory;
  // Pre-rendered HTML — caller must render the JSX template before calling sendEmail.
  html: string;
  related_booking_id?: string;
  related_group_id?: string;
  user_id?: string;
  contact_id?: string;
  reply_to?: string;
  // §23/#1580 — deterministic dedup key forwarded to Resend as the
  // Idempotency-Key header. Resend dedupes retries of the same key within
  // its retention window, so an Inngest step retry or a network-timeout
  // retry that already delivered the first attempt won't double-send.
  // Callers should pass something stable across retries of the same logical
  // send, e.g. `pre_cruise:${booking_id}:${phase}` — NOT a fresh UUID per
  // call, which would defeat the dedup. Optional: sends without one behave
  // exactly as before (no header sent).
  idempotencyKey?: string;
  // Existing keyed callers retain their historical raw Resend key. Features
  // opt into the tenant-scoped v1 key only when they have no legacy provider
  // attempts that must survive a rollout.
  providerIdempotencyKeyScope?: "legacy" | "tenant_scoped_v1";
  // Caller-owned policy/state check that runs at the last possible boundary
  // before the provider call. A false verdict never invokes Resend. Fresh
  // keyed sends abandon their newly queued log; started replays retain it for
  // reconciliation.
  beforeDispatch?: (context: { providerReplay: boolean }) => Promise<boolean | { allowed: boolean; reason?: string }>;
  // §23.7/#1611 — set to the ORIGINAL email_log id when this send is itself a
  // soft-bounce re-send. Two effects: the row is stamped email_log.retry_of so
  // the Resend webhook won't start a fresh retry chain for it, and sendEmail
  // does NOT persist a new email_retry_content row (the original send owns the
  // stored payload; re-sends must not spawn their own retry chains). Absent for
  // normal sends.
  retry_of?: string;
}

// §23.7/#1611 — how long a stored rendered-HTML payload lives before the purge
// cron deletes it. Must exceed Resend's soft-bounce-arrival window plus the full
// +6h/+12h/+24h retry chain (+ terminal grace) so content is never purged out
// from under an in-flight retry. 7 days is a comfortable margin; rendered emails
// are PII, so this is deliberately short.
const RETRY_CONTENT_TTL_DAYS = 7;

export interface EmailSendResult {
  status: "sent" | "suppressed" | "rate_limited" | "cancelled" | "failed";
  reason?: string | null;
  email_log_id?: string | null;
  resend_message_id?: string | null;
}

const RESEND_API_URL = "https://api.resend.com/emails";

type ProviderAttemptState = "unstarted" | "ambiguous" | "rejected";

interface IdempotentOutboxRow {
  email_log_id: string;
  email_status: string;
  sent_at: string | null;
  resend_message_id: string | null;
  provider_first_attempt_at: string | null;
  provider_attempt_state: ProviderAttemptState | null;
}

interface PreparedIdempotentEmail {
  email_log_id: string;
  email_status: string;
  sent_at: string | null;
  resend_message_id: string | null;
  provider_idempotency_key: string | null;
  provider_request_body: string | null;
  provider_account_type: "platform_resend" | "tenant_resend";
  provider_credential_hash: string;
  provider_first_attempt_at: string | null;
  provider_attempt_state: ProviderAttemptState;
  newly_queued: boolean;
}

interface ProviderDispatch {
  email_log_id: string;
  provider_idempotency_key: string;
  provider_request_body: string;
  provider_account_type: "platform_resend" | "tenant_resend";
  provider_credential_hash: string;
  provider_first_attempt_at: string;
}

export interface IdempotentEmailRecovery {
  status: "missing" | "queued" | "sent";
  email_log_id?: string;
  resend_message_id?: string | null;
  sent_at?: string | null;
  provider_first_attempt_at?: string | null;
  provider_attempt_state?: ProviderAttemptState | null;
}

// Verified Resend sending domain is the `email.` subdomain (the apex is not
// verified). All platform-default senders use it.
const PLATFORM_DEFAULT_FROM = "noreply@email.ai-travelconcierge.com";

/**
 * §16.4 from-address resolver. Precedence:
 *   1. If a verified email_from_domain exists AND email_from_address looks
 *      like a local-part-only string (no @), combine them: "support@acme.com".
 *   2. If email_from_address is a full address (contains @), use it as-is.
 *      (Legacy behavior — predates the verified-domain feature; the operator
 *      already typed a full address, so honor it.)
 *   3. If a verified email_from_domain exists but no email_from_address,
 *      use "noreply@<verified-domain>".
 *   4. Fall back to the platform default "noreply@email.ai-travelconcierge.com".
 *
 * "Verified" means email_from_domain_verified_at is non-null. An unverified
 * domain (set in the UI but DNS not yet confirmed) is ignored to prevent
 * sending under a domain we haven't proven we own — Resend would reject the
 * send and the customer would see a bounce.
 */
export function resolveFromAddress(args: {
  email_from_address: string | null;
  email_from_domain: string | null;
  email_from_domain_verified_at: string | null;
}): string {
  const verifiedDomain = args.email_from_domain_verified_at ? args.email_from_domain : null;
  const addr = args.email_from_address?.trim() ?? null;

  if (addr && addr.includes("@")) return addr; // legacy full-address override
  if (verifiedDomain && addr) return `${addr}@${verifiedDomain}`;
  if (verifiedDomain) return `noreply@${verifiedDomain}`;
  if (addr) return addr; // operator typed something but no domain — best effort
  return PLATFORM_DEFAULT_FROM;
}

export function providerEmailIdempotencyKey(
  tenantId: string,
  logicalKey: string,
  scope: NonNullable<SendEmailInput["providerIdempotencyKeyScope"]> = "legacy",
): string {
  if (scope === "legacy") return logicalKey;
  const digest = createHash("sha256").update(logicalKey).digest("hex");
  return `atc:${tenantId}:${digest}`;
}

function providerCredentialHash(apiKey: string, idempotencyKey: string): string {
  return createHmac("sha256", apiKey)
    .update(`atc-email-provider-credential-binding-v1:${idempotencyKey}`)
    .digest("hex");
}

async function readIdempotentOutbox(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
}): Promise<IdempotentOutboxRow | null> {
  const rows = await safeAwait(
    args.db.rpc("recover_idempotent_email_send", {
      p_tenant_id: args.tenantId,
      p_idempotency_key: args.idempotencyKey,
    }),
    "recover_idempotent_email_send",
  );
  return (rows as IdempotentOutboxRow[] | null)?.[0] ?? null;
}

async function finalizeIdempotentEmail(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
  resendMessageId: string | null;
}): Promise<{ email_log_id: string; resend_message_id: string | null }> {
  const rows = await safeAwait(
    args.db.rpc("finalize_idempotent_email_send", {
      p_tenant_id: args.tenantId,
      p_idempotency_key: args.idempotencyKey,
      p_resend_message_id: args.resendMessageId,
    }),
    "finalize_idempotent_email_send",
  );
  const finalized = (rows as Array<{
    email_log_id: string;
    newly_recorded: boolean;
    email_sent_today: number;
  }> | null)?.[0];
  if (!finalized) throw new Error("finalize_idempotent_email_send returned no row");

  const snapshot = await loadTenantSnapshot(args.db, args.tenantId);
  await checkStateTransitionIfNeeded({
    db: args.db,
    tenant: snapshot.tenant,
    dimension: "email_volume",
    metric_value: BigInt(finalized.email_sent_today),
  });

  return {
    email_log_id: finalized.email_log_id,
    resend_message_id: args.resendMessageId,
  };
}

export async function recoverIdempotentEmail(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
}): Promise<IdempotentEmailRecovery> {
  const outbox = await readIdempotentOutbox(args);
  if (!outbox) return { status: "missing" };
  if (!outbox.sent_at) {
    return {
      status: "queued",
      email_log_id: outbox.email_log_id,
      resend_message_id: outbox.resend_message_id,
      provider_first_attempt_at: outbox.provider_first_attempt_at,
      provider_attempt_state: outbox.provider_attempt_state,
    };
  }

  const finalized = await finalizeIdempotentEmail({
    ...args,
    resendMessageId: outbox.resend_message_id,
  });
  return {
    status: "sent",
    email_log_id: finalized.email_log_id,
    resend_message_id: finalized.resend_message_id,
    sent_at: outbox.sent_at,
  };
}

export async function abandonUnstartedIdempotentEmail(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
}): Promise<boolean> {
  const abandoned = await safeAwait(
    args.db.rpc("abandon_unstarted_idempotent_email", {
      p_tenant_id: args.tenantId,
      p_idempotency_key: args.idempotencyKey,
    }),
    "abandon_unstarted_idempotent_email",
  );
  return abandoned === true;
}

function resolveResendApiKey(tenant: SendEmailInput["tenant"]):
  | { ok: true; apiKey: string }
  | { ok: false; reason: string } {
  if (tenant.email_send_pattern === "tenant_resend") {
    if (!tenant.tenant_resend_api_key_encrypted) {
      return { ok: false, reason: "tenant_resend_api_key_not_set" };
    }
    let parsed: { ciphertext: string; key_id: string };
    try {
      parsed = JSON.parse(tenant.tenant_resend_api_key_encrypted) as { ciphertext: string; key_id: string };
    } catch {
      return { ok: false, reason: "encrypted_key_malformed" };
    }
    const decrypted = decryptCredential(parsed);
    return decrypted.ok
      ? { ok: true, apiKey: decrypted.value }
      : { ok: false, reason: `decrypt_failed: ${decrypted.error.code}` };
  }

  const platformKey = process.env.RESEND_API_KEY;
  return platformKey
    ? { ok: true, apiKey: platformKey }
    : { ok: false, reason: "platform_resend_key_not_set" };
}

async function runBeforeDispatch(
  beforeDispatch: SendEmailInput["beforeDispatch"],
  providerReplay: boolean,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!beforeDispatch) return { allowed: true };
  const verdict = await beforeDispatch({ providerReplay });
  if (typeof verdict === "boolean") {
    return verdict ? { allowed: true } : { allowed: false, reason: "before_dispatch_rejected" };
  }
  return verdict.allowed
    ? { allowed: true }
    : { allowed: false, reason: verdict.reason ?? "before_dispatch_rejected" };
}

async function startIdempotentDispatch(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
}): Promise<ProviderDispatch> {
  const rows = await safeAwait(
    args.db.rpc("start_idempotent_email_dispatch", {
      p_tenant_id: args.tenantId,
      p_idempotency_key: args.idempotencyKey,
    }),
    "start_idempotent_email_dispatch",
  );
  const dispatch = (rows as ProviderDispatch[] | null)?.[0];
  if (!dispatch) throw new Error("start_idempotent_email_dispatch returned no row");
  return dispatch;
}

async function fetchProvider(args: {
  apiKey: string;
  body: string;
  providerIdempotencyKey?: string;
}): Promise<
  | { status: "sent"; resendMessageId: string }
  | { status: "failed"; reason: string; outcome: "rejected" | "ambiguous" }
> {
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        ...(args.providerIdempotencyKey ? { "Idempotency-Key": args.providerIdempotencyKey } : {}),
      },
      body: args.body,
    });
    if (!res.ok) {
      recordVendorFailure("resend", `${res.status}`);
      // Retryable provider responses keep the request immutable: a timeout,
      // concurrent key, rate limit, or server failure may not conclusively
      // describe the provider-side delivery state.
      const outcome = (
        res.status === 408
        || res.status === 409
        || res.status === 429
        || res.status >= 500
      ) ? "ambiguous" : "rejected";
      return {
        status: "failed",
        reason: `resend_${res.status}`,
        outcome,
      };
    }

    const body = await res.json() as { id?: string };
    if (!body.id) {
      recordVendorFailure("resend", "missing_message_id");
      return {
        status: "failed",
        reason: "resend_missing_message_id",
        outcome: "ambiguous",
      };
    }
    recordVendorSuccess("resend");
    return { status: "sent", resendMessageId: body.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordVendorFailure("resend", reason);
    return {
      status: "failed",
      reason: `resend_throw: ${String(error)}`,
      outcome: "ambiguous",
    };
  }
}

async function settleIdempotentProviderFailure(args: {
  db: SupabaseClient;
  tenantId: string;
  idempotencyKey: string;
  emailLogId: string;
  provider: Extract<Awaited<ReturnType<typeof fetchProvider>>, { status: "failed" }>;
}): Promise<EmailSendResult> {
  if (args.provider.outcome === "rejected") {
    const marked = await safeAwait(
      args.db.rpc("mark_idempotent_email_dispatch_rejected", {
        p_tenant_id: args.tenantId,
        p_idempotency_key: args.idempotencyKey,
      }),
      "mark_idempotent_email_dispatch_rejected",
    );
    if (marked !== true) {
      const recovered = await recoverIdempotentEmail({
        db: args.db,
        tenantId: args.tenantId,
        idempotencyKey: args.idempotencyKey,
      });
      if (recovered.status === "sent") {
        return {
          status: "sent",
          email_log_id: recovered.email_log_id ?? null,
          resend_message_id: recovered.resend_message_id ?? null,
        };
      }
    }
  }

  return {
    status: "failed",
    reason: args.provider.reason,
    email_log_id: args.emailLogId,
  };
}

export async function resumeIdempotentEmail(args: {
  db: SupabaseClient;
  tenant: SendEmailInput["tenant"];
  idempotencyKey: string;
  beforeDispatch?: SendEmailInput["beforeDispatch"];
}): Promise<EmailSendResult> {
  const recovered = await recoverIdempotentEmail({
    db: args.db,
    tenantId: args.tenant.id,
    idempotencyKey: args.idempotencyKey,
  });
  if (recovered.status === "sent") {
    return {
      status: "sent",
      email_log_id: recovered.email_log_id ?? null,
      resend_message_id: recovered.resend_message_id ?? null,
    };
  }
  if (
    recovered.status !== "queued"
    || recovered.provider_attempt_state !== "ambiguous"
    || !recovered.provider_first_attempt_at
  ) {
    return { status: "failed", reason: "started_idempotent_outbox_not_found" };
  }

  const credential = resolveResendApiKey(args.tenant);
  if (!credential.ok) return { status: "failed", reason: credential.reason };
  const verdict = await runBeforeDispatch(args.beforeDispatch, true);
  if (!verdict.allowed) return { status: "cancelled", reason: verdict.reason ?? null };

  const dispatch = await startIdempotentDispatch({
    db: args.db,
    tenantId: args.tenant.id,
    idempotencyKey: args.idempotencyKey,
  });
  if (dispatch.provider_account_type !== args.tenant.email_send_pattern) {
    return { status: "failed", reason: "provider_account_changed" };
  }
  if (dispatch.provider_credential_hash !== providerCredentialHash(credential.apiKey, args.idempotencyKey)) {
    return { status: "failed", reason: "provider_credential_changed" };
  }
  const provider = await fetchProvider({
    apiKey: credential.apiKey,
    body: dispatch.provider_request_body,
    providerIdempotencyKey: dispatch.provider_idempotency_key,
  });
  if (provider.status === "failed") {
    return settleIdempotentProviderFailure({
      db: args.db,
      tenantId: args.tenant.id,
      idempotencyKey: args.idempotencyKey,
      emailLogId: dispatch.email_log_id,
      provider,
    });
  }

  const finalized = await finalizeIdempotentEmail({
    db: args.db,
    tenantId: args.tenant.id,
    idempotencyKey: args.idempotencyKey,
    resendMessageId: provider.resendMessageId,
  });
  return {
    status: "sent",
    email_log_id: finalized.email_log_id,
    resend_message_id: provider.resendMessageId,
  };
}

export async function sendEmail(input: SendEmailInput): Promise<EmailSendResult> {
  const { db, tenant, to, subject, template_id, category, html } = input;

  const existingOutbox = input.idempotencyKey
    ? await readIdempotentOutbox({ db, tenantId: tenant.id, idempotencyKey: input.idempotencyKey })
    : null;
  if (input.idempotencyKey && existingOutbox?.sent_at) {
    const recovered = await recoverIdempotentEmail({
      db,
      tenantId: tenant.id,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      status: "sent",
      email_log_id: recovered.email_log_id ?? null,
      resend_message_id: recovered.resend_message_id ?? null,
    };
  }
  const providerReplay = existingOutbox?.provider_attempt_state === "ambiguous";

  // §25.10 — Staging outbound isolation. When STAGING_MODE=true and
  // TEST_OVERRIDE_EMAIL is set, redirect ALL outbound email to the test
  // address so a restored prod copy doesn't accidentally email real users.
  // The override happens before suppression checks so we don't accidentally
  // skip-suppress test-mode sends.
  const stagingOverrideTo =
    process.env.STAGING_MODE === "true" ? process.env.TEST_OVERRIDE_EMAIL : null;
  const effectiveTo = stagingOverrideTo ?? to;

  if (!providerReplay) {
    const suppressionReasons: string[] = ["unsubscribe_all", "hard_bounce", "complaint"];
    if (category === "marketing") suppressionReasons.push("unsubscribe_marketing");
    if (category === "travel_news") suppressionReasons.push("unsubscribe_travel_news");

    const suppressions = await safeAwait(
      db
        .from("email_suppressions")
        .select("reason")
        .eq("tenant_id", tenant.id)
        .eq("email_address", to)
        .in("reason", suppressionReasons)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .limit(suppressionReasons.length),
      "email_suppressions.read.send",
    ) as Array<{ reason: string }> | null;

    if (suppressions && suppressions.length > 0) {
      const firstSuppression = suppressions[0] as { reason: string } | undefined;
      return { status: "suppressed", reason: firstSuppression?.reason ?? null };
    }

    const rl = await checkRateLimit({ db, tenant_id: tenant.id, to_email: to, category });
    if (!rl.allowed) {
      return { status: "rate_limited", reason: rl.reason ?? null };
    }
  }

  // Coalesce empty/whitespace too, not just null: a blank email_from_name
  // (tenant_branding stores "" rather than NULL) must fall through to
  // legal_name, else the from header becomes " <addr>" and Resend rejects it
  // with a 422 "Invalid `from` field" — a silent, fail-soft delivery failure.
  const fromName = tenant.email_from_name?.trim() || tenant.legal_name?.trim() || "AI Travel Concierge";
  const fromAddr = resolveFromAddress({
    email_from_address: tenant.email_from_address ?? null,
    email_from_domain: tenant.email_from_domain ?? null,
    email_from_domain_verified_at: tenant.email_from_domain_verified_at ?? null,
  });
  const from = `${fromName} <${fromAddr}>`;
  const providerRequestBody = JSON.stringify({
    from,
    to: effectiveTo,
    subject: stagingOverrideTo ? `[STAGING → ${to}] ${subject}` : subject,
    html,
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
  });
  const credential = resolveResendApiKey(tenant);
  if (!credential.ok) return { status: "failed", reason: credential.reason };
  const credentialHash = input.idempotencyKey
    ? providerCredentialHash(credential.apiKey, input.idempotencyKey)
    : null;

  if (input.idempotencyKey) {
    const expiresAt = new Date(Date.now() + RETRY_CONTENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = await safeAwait(
      db.rpc("prepare_idempotent_email_send_v2", {
        p_tenant_id: tenant.id,
        p_idempotency_key: input.idempotencyKey,
        p_provider_idempotency_key: providerEmailIdempotencyKey(
          tenant.id,
          input.idempotencyKey,
          input.providerIdempotencyKeyScope,
        ),
        p_provider_request_body: providerRequestBody,
        p_provider_account_type: tenant.email_send_pattern,
        p_provider_credential_hash: credentialHash,
        p_log: {
          to_email: to,
          from_email: fromAddr,
          subject,
          template_id,
          template_variables: input.template_variables ?? null,
          email_category: category,
          retry_of: input.retry_of ?? null,
          user_id: input.user_id ?? null,
          contact_id: input.contact_id ?? null,
          reply_to: input.reply_to ?? null,
          related_booking_id: input.related_booking_id ?? null,
          related_group_id: input.related_group_id ?? null,
        },
        p_retry_content: input.retry_of ? null : {
          to_email: to,
          subject,
          template_id,
          email_category: category,
          html,
          expires_at: expiresAt,
          reply_to: input.reply_to ?? null,
          related_booking_id: input.related_booking_id ?? null,
          related_group_id: input.related_group_id ?? null,
          user_id: input.user_id ?? null,
          contact_id: input.contact_id ?? null,
        },
      }),
      "prepare_idempotent_email_send_v2",
    );
    const prepared = (rows as PreparedIdempotentEmail[] | null)?.[0];
    if (!prepared) throw new Error("prepare_idempotent_email_send_v2 returned no row");
    if (prepared.sent_at) {
      const recovered = await recoverIdempotentEmail({
        db,
        tenantId: tenant.id,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        status: "sent",
        email_log_id: recovered.email_log_id ?? null,
        resend_message_id: recovered.resend_message_id ?? null,
      };
    }
    if (prepared.provider_account_type !== tenant.email_send_pattern) {
      return { status: "failed", reason: "provider_account_changed", email_log_id: prepared.email_log_id };
    }
    if (prepared.provider_credential_hash !== credentialHash) {
      return { status: "failed", reason: "provider_credential_changed", email_log_id: prepared.email_log_id };
    }

    const preparedReplay = prepared.provider_attempt_state === "ambiguous";
    const verdict = await runBeforeDispatch(input.beforeDispatch, preparedReplay);
    if (!verdict.allowed) {
      if (!preparedReplay) {
        await abandonUnstartedIdempotentEmail({
          db,
          tenantId: tenant.id,
          idempotencyKey: input.idempotencyKey,
        });
      }
      return { status: "cancelled", reason: verdict.reason ?? null };
    }

    const dispatch = await startIdempotentDispatch({
      db,
      tenantId: tenant.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (dispatch.provider_account_type !== tenant.email_send_pattern) {
      return { status: "failed", reason: "provider_account_changed", email_log_id: prepared.email_log_id };
    }
    if (dispatch.provider_credential_hash !== credentialHash) {
      return { status: "failed", reason: "provider_credential_changed", email_log_id: prepared.email_log_id };
    }
    const provider = await fetchProvider({
      apiKey: credential.apiKey,
      body: dispatch.provider_request_body,
      providerIdempotencyKey: dispatch.provider_idempotency_key,
    });
    if (provider.status === "failed") {
      return settleIdempotentProviderFailure({
        db,
        tenantId: tenant.id,
        idempotencyKey: input.idempotencyKey,
        emailLogId: prepared.email_log_id,
        provider,
      });
    }

    const finalized = await finalizeIdempotentEmail({
      db,
      tenantId: tenant.id,
      idempotencyKey: input.idempotencyKey,
      resendMessageId: provider.resendMessageId,
    });
    return {
      status: "sent",
      email_log_id: finalized.email_log_id,
      resend_message_id: provider.resendMessageId,
    };
  }

  const verdict = await runBeforeDispatch(input.beforeDispatch, false);
  if (!verdict.allowed) return { status: "cancelled", reason: verdict.reason ?? null };
  const provider = await fetchProvider({ apiKey: credential.apiKey, body: providerRequestBody });
  const sendStatus: "sent" | "failed" = provider.status;
  const resendMessageId = provider.status === "sent" ? provider.resendMessageId : undefined;
  const sendFailReason = provider.status === "failed" ? provider.reason : undefined;

  // Legacy local effects remain unchanged for callers without an idempotency key.
  const logRow: Record<string, unknown> = {
    tenant_id: tenant.id,
    to_email: to,
    from_email: fromAddr,
    subject,
    template_id,
    template_variables: input.template_variables ?? null,
    email_category: category,
    status: sendStatus === "sent" ? "sent" : "rejected",
    sent_at: sendStatus === "sent" ? new Date().toISOString() : null,
    resend_message_id: resendMessageId ?? null,
    ...(input.retry_of ? { retry_of: input.retry_of } : {}),
    ...(input.user_id ? { user_id: input.user_id } : {}),
    ...(input.contact_id ? { contact_id: input.contact_id } : {}),
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    ...(input.related_booking_id ? { related_booking_id: input.related_booking_id } : {}),
    ...(input.related_group_id ? { related_group_id: input.related_group_id } : {}),
  };

  // Non-fatal: the email was already handed to the vendor above, so a failed
  // audit-log insert must NOT flip a delivered email to "failed". Surface the
  // discarded error as a warning (D-091, #400) — the row is missing, not the
  // send.
  const { data: logRow_, error: logErr } = await db.from("email_log").insert(logRow).select("id").single();
  if (logErr) console.warn(`[email/send] email_log insert failed (non-fatal): ${logErr.message}`);
  const emailLogId = (logRow_ as { id?: string } | null)?.id;

  if (sendStatus === "failed") {
    return { status: "failed", reason: sendFailReason ?? null, email_log_id: emailLogId ?? null };
  }

  // §23.7/#1611 — persist the rendered payload so a soft bounce can re-send it
  // verbatim (option (a)). Only for ORIGINAL sends (not re-sends — the original
  // owns the retry chain) and only once we have an email_log id to key on.
  // Written AFTER dispatch (D-091 #10) and non-fatal: the email is already with
  // the vendor, so a failed content insert must NOT flip a delivered send to
  // failed — it only means this particular send can't be retried on a bounce.
  if (!input.retry_of && emailLogId) {
    try {
      const expiresAt = new Date(Date.now() + RETRY_CONTENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { error: retryErr } = await db.from("email_retry_content").insert({
        email_log_id: emailLogId,
        tenant_id: tenant.id,
        to_email: to,
        subject,
        template_id,
        email_category: category,
        html,
        expires_at: expiresAt,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        ...(input.related_booking_id ? { related_booking_id: input.related_booking_id } : {}),
        ...(input.related_group_id ? { related_group_id: input.related_group_id } : {}),
        ...(input.user_id ? { user_id: input.user_id } : {}),
        ...(input.contact_id ? { contact_id: input.contact_id } : {}),
      });
      if (retryErr) console.warn(`[email/send] email_retry_content insert failed (non-fatal): ${retryErr.message}`);
    } catch (err) {
      console.warn(`[email/send] email_retry_content insert threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // BP27 §27.4 — bump the email-sent counter so the daily soft1/soft2/hard
  // limits + state-machine transitions fire. Non-fatal: if the counter
  // increment or snapshot load fails, the send still succeeds (an email
  // already delivered to Resend MUST NOT be reported as failed).
  try {
    const snapshot = await loadTenantSnapshot(db, tenant.id);
    await incrementEmailSent({ db, tenant: snapshot.tenant });
  } catch (err) {
    console.warn(`[email/send] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return { status: "sent", email_log_id: emailLogId ?? null, resend_message_id: resendMessageId ?? null };
}
