// Unit tests for the quarterly backup-verification helper — §13.5.3.
//
// verifyBackup is a pure function (keys passed as args, no env/DB), so it tests
// directly. Focus: the AES-GCM auth-tag-length hardening (#551) must reject a
// short/truncated tag rather than attempting decryption with it.

import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { verifyBackup } from "@/lib/crypto/verify-backup";

// Wire format mirrors credential-cipher: base64( iv[12] || tag[16] || ct[n] ).
function seal(
  key: Buffer,
  plaintext: string,
  authTagLength = 16,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

describe("verify-backup (§13.5.3)", () => {
  it("passes for a well-formed full-tag ciphertext (non-vacuous baseline)", () => {
    const key = randomBytes(32);
    const result = verifyBackup({
      test_ciphertext_b64: seal(key, "backup-test-vector"),
      expected_plaintext: "backup-test-vector",
      backup_keys: { current: key.toString("base64") },
      backup_key_ids: { current: "backup-v1" },
    });
    expect(result.passed).toBe(true);
  });

  it("rejects a short (8-byte) GCM auth tag instead of decrypting with it (#551)", () => {
    // Empty plaintext makes the tag region genuinely 8 bytes in the fixed-offset
    // wire format. Without the length gate this falls through to setAuthTag and
    // the failure is reported as a generic "could not decrypt" — the gate names
    // the real cause (short tag) and fails closed.
    const key = randomBytes(32);
    const result = verifyBackup({
      test_ciphertext_b64: seal(key, "", 8),
      expected_plaintext: "", // not reached — tag-length guard returns before decrypt

      backup_keys: { current: key.toString("base64") },
      backup_key_ids: { current: "backup-v1" },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/Auth tag is 8 bytes/);
  });
});
