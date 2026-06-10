// Unit tests for AES-256-GCM credential encryption — §13.5
//
// Covers all four failure modes from §13.5.2 plus key rotation flow.
// Each test is self-contained (no real Supabase calls).

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";

// We mock the env() call so tests don't need real env vars
// and can exercise different key/key-id combinations.

const CURRENT_KEY_B64 = Buffer.from("a".repeat(32)).toString("base64"); // 32 bytes
const CURRENT_KEY_ID = "v1";
const PREVIOUS_KEY_B64 = Buffer.from("b".repeat(32)).toString("base64"); // 32 bytes
const PREVIOUS_KEY_ID = "v0";

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENCRYPTION_KEY_CURRENT: CURRENT_KEY_B64,
    APP_ENCRYPTION_KEY_ID_CURRENT: CURRENT_KEY_ID,
    APP_ENCRYPTION_KEY_PREVIOUS: undefined,
    APP_ENCRYPTION_KEY_ID_PREVIOUS: undefined,
    ...overrides,
  };
}

vi.mock("@/lib/env", () => {
  let _mockEnv: ReturnType<typeof makeEnv> = makeEnv();
  return {
    env: () => _mockEnv,
    __setMockEnv: (e: ReturnType<typeof makeEnv>) => {
      _mockEnv = e;
    },
  };
});

// Import after mocking
const { encryptCredential, decryptCredential } = await import(
  "@/lib/crypto/credential-cipher"
);
const { __setMockEnv } = await import("@/lib/env" as never) as {
  __setMockEnv: (e: ReturnType<typeof makeEnv>) => void;
};

afterEach(() => {
  __setMockEnv(makeEnv());
});

describe("credential-cipher (§13.5)", () => {
  it("encrypt → decrypt round-trip with current key returns original plaintext", () => {
    const plaintext = "my-secret-api-key-12345";
    const encrypted = encryptCredential(plaintext);
    expect(encrypted.key_id).toBe(CURRENT_KEY_ID);

    const result = decryptCredential(encrypted);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(plaintext);
    }
  });

  it("each encrypt call produces a different ciphertext (fresh IV)", () => {
    const plaintext = "same-plaintext";
    const a = encryptCredential(plaintext);
    const b = encryptCredential(plaintext);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("key rotation: encrypt under current → rotate → decrypt via previous-key fallback", () => {
    const plaintext = "credentials-written-under-old-key";
    const encrypted = encryptCredential(plaintext);
    expect(encrypted.key_id).toBe(CURRENT_KEY_ID);

    // Simulate rotation: previous = old current, current = new key
    const NEW_KEY_B64 = Buffer.from("c".repeat(32)).toString("base64");
    __setMockEnv(
      makeEnv({
        APP_ENCRYPTION_KEY_CURRENT: NEW_KEY_B64,
        APP_ENCRYPTION_KEY_ID_CURRENT: "v2",
        APP_ENCRYPTION_KEY_PREVIOUS: CURRENT_KEY_B64,
        APP_ENCRYPTION_KEY_ID_PREVIOUS: CURRENT_KEY_ID,
      }),
    );

    const result = decryptCredential(encrypted);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(plaintext);
    }
  });

  it("decrypt with unknown key_id returns Err({ code: 'unknown_key_id' })", () => {
    const result = decryptCredential({ ciphertext: "AAAA", key_id: "v999" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown_key_id");
      expect(result.error.key_id).toBe("v999");
    }
  });

  it("tampered ciphertext returns Err({ code: 'auth_tag_mismatch' })", () => {
    const encrypted = encryptCredential("some-credential");
    // Corrupt the ciphertext by flipping the last byte
    const bundle = Buffer.from(encrypted.ciphertext, "base64");
    const lastIdx = bundle.length - 1;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    bundle[lastIdx] = (bundle[lastIdx]! ^ 0xff) & 0xff;
    const tampered = bundle.toString("base64");

    const result = decryptCredential({ ciphertext: tampered, key_id: CURRENT_KEY_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Auth tag mismatch or decryption_failed — either is correct depending on where corruption lands
      expect(["auth_tag_mismatch", "decryption_failed"]).toContain(result.error.code);
    }
  });

  it("rejects a credential sealed with a short (8-byte) GCM auth tag (#551)", () => {
    // Node accepts 4–16 byte GCM tags when authTagLength is unset, so a caller
    // controlling the stored bundle could supply a shorter, more forgeable tag.
    // This builds a bundle whose tag is a REAL 8-byte GCM tag over empty
    // ciphertext; the explicit tag.length gate rejects it as auth_tag_mismatch
    // BEFORE setAuthTag. Non-vacuous: without the gate, setAuthTag itself throws
    // "Invalid authentication tag length", which the catch maps to the generic
    // "decryption_failed" (the message lacks its "auth tag" substring) — a
    // different code than this test asserts, so a revert fails here.
    const key = Buffer.from("a".repeat(32)); // matches CURRENT_KEY_B64 decoded
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 8 });
    const enc = Buffer.concat([cipher.update("", "utf8"), cipher.final()]); // empty ciphertext
    const shortTag = cipher.getAuthTag();
    expect(shortTag.length).toBe(8);
    // Wire format iv||tag||ct: with empty ct the tag region is genuinely 8 bytes.
    const bundle = Buffer.concat([iv, shortTag, enc]);

    const result = decryptCredential({
      ciphertext: bundle.toString("base64"),
      key_id: CURRENT_KEY_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth_tag_mismatch");
    }
  });

  it("previous key absent → unknown_key_id when record has old key_id", () => {
    // No PREVIOUS key set, but record was written under a previous key
    const result = decryptCredential({
      ciphertext: "AAAA",
      key_id: PREVIOUS_KEY_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown_key_id");
    }
  });

  // #738 — AAD binding
  it("#738: mutated key_id on a new ciphertext returns auth_tag_mismatch", () => {
    // encryptCredential now binds key_id into AAD; changing key_id in the
    // stored payload must invalidate the GCM auth tag.
    const encrypted = encryptCredential("sensitive-value");
    const tampered = { ...encrypted, key_id: "v-attacker" };
    // Both 'v-attacker' and the real key_id must fail to resolve, so we
    // set an env with 'v-attacker' pointing to the same key material —
    // which tests that the TAG mismatch (not the key-lookup failure) is
    // the actual rejection reason.
    __setMockEnv(
      makeEnv({
        APP_ENCRYPTION_KEY_CURRENT: CURRENT_KEY_B64,
        APP_ENCRYPTION_KEY_ID_CURRENT: "v-attacker",
        APP_ENCRYPTION_KEY_PREVIOUS: CURRENT_KEY_B64,
        APP_ENCRYPTION_KEY_ID_PREVIOUS: CURRENT_KEY_ID,
      }),
    );
    const result = decryptCredential(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth_tag_mismatch");
    }
  });

  it("#738: legacy ciphertext (no AAD) still decrypts via fallback", () => {
    // Simulate a ciphertext that was encrypted before AAD was added.
    // Build it directly using Node crypto without setAAD.
    const key = Buffer.from(CURRENT_KEY_B64, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const bundle = Buffer.concat([iv, tag, ciphertext]).toString("base64");

    const result = decryptCredential({ ciphertext: bundle, key_id: CURRENT_KEY_ID });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("legacy-secret");
    }
  });
});

// verifyEnvAtBoot key-length validation is tested in env-boot-validation.test.ts
// (separate file, no module-level env mock).
