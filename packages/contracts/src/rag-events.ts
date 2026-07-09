// @atc/contracts/rag-events — single source of truth for the main→rag webhook
// plumbing: the HMAC sign/verify pair AND the event envelopes.
//
// Before this module (#1595) the HMAC-SHA256→hex helper was copy-pasted in 7
// places and the verify-side compare tripled, while producer TS types (main)
// and consumer zod schemas (rag) were hand-mirrored and had already drifted
// (rag bounded platform `key` to max(128), main didn't). Consolidating both
// sides here means a single implementation and a single schema: producers take
// their types via z.infer, consumers validate with .parse.
//
// Web Crypto (crypto.subtle) + a pure-JS constant-time hex compare — NO
// node:crypto — so this stays runtime-agnostic and safe to re-export from the
// @atc/contracts barrel that edge code also consumes.

import { z } from "zod";

// ── HMAC sign / verify ────────────────────────────────────────────────────

// HMAC-SHA256 of `body` under `secret`, lowercase hex. This exact encoding is
// the wire contract for the `x-webhook-signature` header; the recorded-signature
// fixture test pins it so a change here can't silently break every receiver.
export async function hmacHexSign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time compare of two equal-length lowercase-hex strings. The length
// check both short-circuits an obvious mismatch and keeps the XOR loop from
// leaking the shorter length via early exit.
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Verify a provided `x-webhook-signature` against the HMAC of the raw body.
// Returns false (never throws) for a missing/empty/mismatched signature so
// callers fail closed with a single 401 branch.
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  providedSignature: string | null | undefined,
): Promise<boolean> {
  if (!providedSignature) return false;
  const expected = await hmacHexSign(secret, rawBody);
  return timingSafeHexEqual(providedSignature, expected);
}

// ── Event envelopes ───────────────────────────────────────────────────────

export const TenantEventTypeSchema = z.enum([
  "tenant.created",
  "tenant.status_changed",
  "tenant.terminated",
  "tenant.metadata_updated",
]);
export type TenantEventType = z.infer<typeof TenantEventTypeSchema>;

export const TenantEventSchema = z.object({
  event_type: TenantEventTypeSchema,
  tenant_id: z.string().uuid(),
  source_revision: z.number().int().nonnegative(),
  payload: z.object({
    status: z.string(),
    tenant_type: z.string(),
    display_name: z.string(),
  }),
});
export type TenantEvent = z.infer<typeof TenantEventSchema>;
export type TenantEventPayload = TenantEvent["payload"];

export const PlatformEventSchema = z.object({
  event_type: z.literal("platform_settings.updated"),
  source_revision: z.number().int().nonnegative(),
  payload: z.object({
    changes: z
      .array(
        z.object({
          key: z.string().min(1).max(128),
          // value is JSONB — accept anything serialisable.
          value: z.unknown(),
        }),
      )
      .min(1),
  }),
});
export type PlatformEvent = z.infer<typeof PlatformEventSchema>;
export type PlatformEventType = PlatformEvent["event_type"];
export type PlatformSettingsEventPayload = PlatformEvent["payload"];

export const ChunkFeedbackEventSchema = z.object({
  message_id: z.string().uuid().nullable(),
  signal_direction: z.enum(["up", "down"]),
  raw_weight: z.number().min(0).max(10),
  chunk_ids: z.array(z.string().uuid()).min(1).max(20),
});
export type ChunkFeedbackEvent = z.infer<typeof ChunkFeedbackEventSchema>;
