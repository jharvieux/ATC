// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §13.5 — Application-layer AES-256-GCM credential encryption.
//
// Ciphertext wire format: base64( iv[12] || tag[16] || ciphertext[n] )
// Key source: APP_ENCRYPTION_KEY_CURRENT / APP_ENCRYPTION_KEY_PREVIOUS env vars.
// Key IDs are stamped on every ciphertext so the decrypt path knows which key to use.
//
// NEVER throw from decryptCredential — always return a structured Result.
// See §13.5.3: "returns a structured error (NOT a thrown exception that crashes the request)".

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { env } from "@/lib/env";
import { writeAuditLog } from "@/lib/audit/write";
import type { Result } from "@atc/shared-types";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export type DecryptionErrorCode =
  | "unknown_key_id"
  | "auth_tag_mismatch"
  | "decryption_failed";

export interface DecryptionError {
  code: DecryptionErrorCode;
  key_id: string;
}

function getKeyBuffer(keyBase64: string): Buffer {
  return Buffer.from(keyBase64, "base64");
}

export function encryptCredential(plaintext: string): { ciphertext: string; key_id: string } {
  const e = env();
  const key = getKeyBuffer(e.APP_ENCRYPTION_KEY_CURRENT);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bundle = Buffer.concat([iv, tag, encrypted]);
  return {
    ciphertext: bundle.toString("base64"),
    key_id: e.APP_ENCRYPTION_KEY_ID_CURRENT,
  };
}

export function decryptCredential(payload: {
  ciphertext: string;
  key_id: string;
}): Result<string, DecryptionError> {
  const e = env();
  const { ciphertext, key_id } = payload;

  let keyBase64: string;
  if (key_id === e.APP_ENCRYPTION_KEY_ID_CURRENT) {
    keyBase64 = e.APP_ENCRYPTION_KEY_CURRENT;
  } else if (
    e.APP_ENCRYPTION_KEY_PREVIOUS !== undefined &&
    key_id === e.APP_ENCRYPTION_KEY_ID_PREVIOUS
  ) {
    keyBase64 = e.APP_ENCRYPTION_KEY_PREVIOUS;
  } else {
    logDecryptionFailure({ ciphertext, key_id, code: "unknown_key_id" });
    return { ok: false, error: { code: "unknown_key_id", key_id } };
  }

  try {
    const bundle = Buffer.from(ciphertext, "base64");
    const iv = bundle.subarray(0, IV_BYTES);
    const tag = bundle.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = bundle.subarray(IV_BYTES + TAG_BYTES);

    const key = getKeyBuffer(keyBase64);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return { ok: true, value: plaintext.toString("utf8") };
  } catch (err) {
    const isAuthTagError =
      err instanceof Error &&
      (err.message.includes("Unsupported state") ||
        err.message.includes("auth tag") ||
        err.message.includes("bad decrypt"));
    const code: DecryptionErrorCode = isAuthTagError ? "auth_tag_mismatch" : "decryption_failed";
    logDecryptionFailure({ ciphertext, key_id, code });
    return { ok: false, error: { code, key_id } };
  }
}

// §13.5.3: Audit-log every decryption failure with a SHA-256 hash of the
// ciphertext (NOT the ciphertext itself) for forensic correlation.
function logDecryptionFailure(payload: {
  ciphertext: string;
  key_id: string;
  code: DecryptionErrorCode;
}): void {
  const ciphertext_sha256 = createHash("sha256")
    .update(payload.ciphertext)
    .digest("hex");
  // Fire-and-forget — the decrypt path can't await this without changing
  // its signature, and the audit row isn't load-bearing for the result.
  void writeAuditLog({
    actor_type: "system",
    action: "credential.decryption_failed",
    resource_type: "credential",
    changes: {
      ciphertext_sha256,
      failure_code: payload.code,
      key_id: payload.key_id,
    },
  });
}
