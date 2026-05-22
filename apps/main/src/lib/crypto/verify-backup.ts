// §13.5.3 — Backup verification helper for quarterly operator verification.
//
// The operator restores the backup key set into a sandbox, runs this helper
// against a known test ciphertext, and asserts passed: true.
//
// This module is intentionally standalone — it accepts the backup keys as
// arguments rather than reading from env vars. The backup keys live OUTSIDE
// the Vercel env (that's the point), so the operator supplies them directly
// during the verification process.

import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export interface BackupVerificationInput {
  test_ciphertext_b64: string;
  expected_plaintext: string;
  backup_keys: { current: string; previous?: string };
  backup_key_ids: { current: string; previous?: string };
}

export interface BackupVerificationResult {
  passed: boolean;
  reason?: string;
}

export function verifyBackup(input: BackupVerificationInput): BackupVerificationResult {
  const { test_ciphertext_b64, expected_plaintext, backup_keys, backup_key_ids } = input;

  // Determine which key to use based on key_id embedded in the ciphertext
  // For verification, we try current first, then previous.
  for (const [keyBase64, keyId] of [
    [backup_keys.current, backup_key_ids.current] as const,
    ...(backup_keys.previous && backup_key_ids.previous
      ? [[backup_keys.previous, backup_key_ids.previous] as const]
      : []),
  ]) {
    try {
      const bundle = Buffer.from(test_ciphertext_b64, "base64");
      const iv = bundle.subarray(0, IV_BYTES);
      const tag = bundle.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const encrypted = bundle.subarray(IV_BYTES + TAG_BYTES);
      const key = Buffer.from(keyBase64, "base64");

      if (key.length !== 32) {
        return {
          passed: false,
          reason: `Backup key '${keyId}' decodes to ${key.length} bytes, expected 32.`,
        };
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");

      if (plaintext === expected_plaintext) {
        return { passed: true };
      }
      return {
        passed: false,
        reason: `Decryption succeeded but plaintext did not match expected value (key: ${keyId}).`,
      };
    } catch {
      // Try next key
    }
  }

  return {
    passed: false,
    reason: "Could not decrypt test ciphertext with any provided backup key.",
  };
}
