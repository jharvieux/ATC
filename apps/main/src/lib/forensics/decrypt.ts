// §26.5a — Forensics snapshot decryption.
//
// MUST be called inside a withPlatformAdminAudit wrapper. The
// platformAdminClient() ALS reader throws if not — that's the access
// control. Key rotation grace: matches encryption_key_id against
// FORENSICS_ENCRYPTION_KEY_CURRENT, then _PRIOR_1, then _PRIOR_2.
//
// Never logs the decrypted payload. The caller (runbook-driven manual
// review) is responsible for safe handling per §26.5a.

import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { platformAdminClient } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ForensicsSnapshotMetadata {
  snapshot_type: string;
  reason: string;
  captured_at: string;
  captured_by_user_id: string | null;
}

export class ForensicsKeyMissingError extends Error {
  readonly code = "forensics_key_missing" as const;
  constructor(key_id: string) {
    super(`No FORENSICS_ENCRYPTION_KEY matches key_id '${key_id}'. Snapshot cannot be decrypted with current env.`);
  }
}

export class ForensicsSnapshotNotFoundError extends Error {
  readonly code = "forensics_snapshot_not_found" as const;
}

function resolveKey(key_id: string): string | null {
  if (key_id === (process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT ?? "forensics-v1")) {
    return process.env.FORENSICS_ENCRYPTION_KEY_CURRENT ?? null;
  }
  // Prior keys aren't stamped with their own ID — operator convention is
  // to set FORENSICS_ENCRYPTION_KEY_PRIOR_N along with the matching
  // FORENSICS_ENCRYPTION_KEY_ID_PRIOR_N. For now, allow PRIOR_1 / _2 to
  // map by ID env var when set.
  if (key_id === process.env.FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1) {
    return process.env.FORENSICS_ENCRYPTION_KEY_PRIOR_1 ?? null;
  }
  if (key_id === process.env.FORENSICS_ENCRYPTION_KEY_ID_PRIOR_2) {
    return process.env.FORENSICS_ENCRYPTION_KEY_PRIOR_2 ?? null;
  }
  return null;
}

export async function decryptForensicsSnapshot(snapshot_id: string): Promise<{
  payload: unknown;
  metadata: ForensicsSnapshotMetadata;
}> {
  // ALS check — throws if not inside withPlatformAdminAudit.
  const db = platformAdminClient();

  const { data, error } = await db
    .from("forensics_log")
    .select("encrypted_payload, encryption_key_id, snapshot_type, reason, captured_at, captured_by_user_id")
    .eq("id", snapshot_id)
    .maybeSingle();

  if (error) throw new Error(`forensics_decrypt_lookup_failed: ${error.message}`);
  if (!data) throw new ForensicsSnapshotNotFoundError(`snapshot ${snapshot_id} not found`);

  const row = data as {
    encrypted_payload: string | Buffer;
    encryption_key_id: string;
    snapshot_type: string;
    reason: string;
    captured_at: string;
    captured_by_user_id: string | null;
  };

  const keyBase64 = resolveKey(row.encryption_key_id);
  if (!keyBase64) {
    throw new ForensicsKeyMissingError(row.encryption_key_id);
  }

  // BYTEA may arrive as a Buffer or as a base64-encoded string depending on
  // PostgREST configuration. Normalize.
  const bundle = Buffer.isBuffer(row.encrypted_payload)
    ? row.encrypted_payload
    : Buffer.from(String(row.encrypted_payload).replace(/^\\x/, ""), "hex");
  const iv = bundle.subarray(0, IV_BYTES);
  const tag = bundle.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bundle.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, Buffer.from(keyBase64, "base64"), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  const payload = JSON.parse(plaintext);

  // Update access bookkeeping. last_accessed_at first, then read-then-write
  // for the access_count increment (PostgREST doesn't expose increment so we
  // do it client-side — race here is benign; admin-only path, low concurrency).
  await safeAwait(
    db
      .from("forensics_log")
      .update({
        last_accessed_at: new Date().toISOString(),
      })
      .eq("id", snapshot_id),
    "forensics_log.update.last_accessed_at",
  );
  const { data: countRow } = await db
    .from("forensics_log")
    .select("access_count")
    .eq("id", snapshot_id)
    .maybeSingle();
  const currentCount = (countRow as { access_count?: number } | null)?.access_count ?? 0;
  await safeAwait(
    db
      .from("forensics_log")
      .update({ access_count: currentCount + 1 })
      .eq("id", snapshot_id),
    "forensics_log.update.access_count",
  );

  return {
    payload,
    metadata: {
      snapshot_type: row.snapshot_type,
      reason: row.reason,
      captured_at: row.captured_at,
      captured_by_user_id: row.captured_by_user_id,
    },
  };
}
