// §26.5a — Forensics snapshot capture.
//
// AES-256-GCM encryption with the dedicated FORENSICS_ENCRYPTION_KEY_* envs
// (boot-time guarantees separation from APP_ENCRYPTION_KEY_*). Write-only
// here — decrypt path + access controls + retention cron land in BP26 per
// §26.5a "manual decryption with operator-controlled keys, paired with a
// court order or signed engagement letter".
//
// Wire format mirrors lib/crypto/credential-cipher.ts: iv[12] || tag[16] || ciphertext.
// Stored as BYTEA in forensics_log.encrypted_payload (so no base64 layer
// around the bundle bytes themselves).

import { createCipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SupabaseClient } from "@supabase/supabase-js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const FORENSICS_RETENTION_DAYS = 90;

export interface CaptureInput {
  tenant_id: string | null;
  snapshot_type:
    | "commission_dispute"
    | "booking_dispute"
    | "tenant_complaint"
    | "ai_misbehavior_investigation"
    | "data_export_request"
    | "security_incident";
  reason: string;
  // Anything JSON-serializable. The caller is responsible for assembling the
  // payload; this function does not query the DB.
  payload: unknown;
  // Bare UUID (audit_log doesn't exist yet — D-036).
  audit_log_id?: string | null;
  captured_by_user_id?: string | null;
}

export interface CaptureResult {
  snapshot_id: string;
}

function encryptToBundle(plaintext: string, keyBase64: string, keyId: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  // #739: bind keyId into AAD so mutating encryption_key_id in DB invalidates the auth tag.
  cipher.setAAD(Buffer.from(keyId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function buildRedactedSummary(input: CaptureInput, payloadSize: number): Record<string, unknown> {
  // Safe preview: counts, type, reason — NEVER the payload itself.
  return {
    snapshot_type: input.snapshot_type,
    reason: input.reason,
    tenant_id: input.tenant_id,
    payload_size_bytes: payloadSize,
    captured_by_user_id: input.captured_by_user_id ?? null,
  };
}

export async function captureForensicsSnapshot(
  db: SupabaseClient,
  input: CaptureInput,
): Promise<CaptureResult> {
  const keyBase64 = process.env.FORENSICS_ENCRYPTION_KEY_CURRENT;
  const keyId = process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT ?? "forensics-v1";
  if (!keyBase64) {
    throw new Error("captureForensicsSnapshot: FORENSICS_ENCRYPTION_KEY_CURRENT not set");
  }

  const plaintext = JSON.stringify(input.payload ?? {});
  const bundle = encryptToBundle(plaintext, keyBase64, keyId);

  const purgeAfter = new Date(Date.now() + FORENSICS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const insertPayload: Record<string, unknown> = {
    tenant_id: input.tenant_id,
    snapshot_type: input.snapshot_type,
    reason: input.reason,
    encrypted_payload: bundle,
    encryption_key_id: keyId,
    redacted_summary: buildRedactedSummary(input, plaintext.length),
    captured_by_user_id: input.captured_by_user_id ?? null,
    purge_after: purgeAfter,
    legal_hold: false,
    access_count: 0,
  };
  if (input.audit_log_id) {
    insertPayload.audit_log_id = input.audit_log_id;
  }

  const { data, error } = await db
    .from("forensics_log")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`forensics_capture_failed: ${error?.message ?? "unknown"}`);
  }
  return { snapshot_id: (data as { id: string }).id };
}
