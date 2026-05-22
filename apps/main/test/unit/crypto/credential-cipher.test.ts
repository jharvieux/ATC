// Unit tests for AES-256-GCM credential encryption — §13.5
//
// Covers all four failure modes from §13.5.2 plus key rotation flow.
// Each test is self-contained (no real Supabase calls).

import { describe, it, expect, vi, afterEach } from "vitest";

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
});

// verifyEnvAtBoot key-length validation is tested in env-boot-validation.test.ts
// (separate file, no module-level env mock).
