// Unit tests for forensics snapshot decryption — §26.5a / #739
//
// Covers: round-trip (AAD-bound), legacy no-AAD fallback, mutated encryption_key_id
// rejection, and missing-key error. No real DB calls — platformAdminClient is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const CURRENT_KEY_B64 = Buffer.from("a".repeat(32)).toString("base64");
const CURRENT_KEY_ID = "forensics-v1";

const mocks = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  rowError: null as { message: string } | null,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  platformAdminClient: () => ({
    from: (_table: string) => ({
      select: (cols: string) => {
        if (cols === "access_count") {
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: { access_count: 0 }, error: null }),
            }),
          };
        }
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: mocks.row, error: mocks.rowError }),
          }),
        };
      },
      update: (_payload: Record<string, unknown>) => ({
        eq: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
  }),
}));

// Import after mocking
const { decryptForensicsSnapshot, ForensicsKeyMissingError, ForensicsSnapshotNotFoundError } =
  await import("@/lib/forensics/decrypt");

function buildBundle(plaintext: string, keyB64: string, keyId: string, withAAD: boolean): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (withAAD) cipher.setAAD(Buffer.from(keyId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function makeRow(bundle: Buffer, keyId: string): Record<string, unknown> {
  return {
    encrypted_payload: bundle,
    encryption_key_id: keyId,
    snapshot_type: "security_incident",
    reason: "test-reason",
    captured_at: new Date().toISOString(),
    captured_by_user_id: null,
  };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [
    "FORENSICS_ENCRYPTION_KEY_CURRENT",
    "FORENSICS_ENCRYPTION_KEY_ID_CURRENT",
    "FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1",
    "FORENSICS_ENCRYPTION_KEY_PRIOR_1",
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.FORENSICS_ENCRYPTION_KEY_CURRENT = CURRENT_KEY_B64;
  process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT = CURRENT_KEY_ID;
  delete process.env.FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1;
  delete process.env.FORENSICS_ENCRYPTION_KEY_PRIOR_1;
  mocks.row = null;
  mocks.rowError = null;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("decryptForensicsSnapshot (#739)", () => {
  it("round-trip: AAD-bound snapshot decrypts to original payload", async () => {
    const payload = { event: "security_incident", user_id: "u-1" };
    const bundle = buildBundle(JSON.stringify(payload), CURRENT_KEY_B64, CURRENT_KEY_ID, true);
    mocks.row = makeRow(bundle, CURRENT_KEY_ID);

    const result = await decryptForensicsSnapshot("snap-1");
    expect(result.payload).toEqual(payload);
    expect(result.metadata.snapshot_type).toBe("security_incident");
    expect(result.metadata.reason).toBe("test-reason");
  });

  it("#739: legacy snapshot (no AAD) still decrypts via fallback", async () => {
    const payload = { event: "legacy_capture" };
    const bundle = buildBundle(JSON.stringify(payload), CURRENT_KEY_B64, CURRENT_KEY_ID, false);
    mocks.row = makeRow(bundle, CURRENT_KEY_ID);

    const result = await decryptForensicsSnapshot("snap-legacy");
    expect(result.payload).toEqual(payload);
  });

  it("#739: mutated encryption_key_id on AAD-bound snapshot causes both decrypt paths to fail", async () => {
    const payload = { event: "tamper_test" };
    // Encrypt with the real key ID in AAD
    const bundle = buildBundle(JSON.stringify(payload), CURRENT_KEY_B64, CURRENT_KEY_ID, true);

    // Attacker changes encryption_key_id in DB; wire up the evil ID to the same key material
    const EVIL_KEY_ID = "forensics-evil";
    process.env.FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1 = EVIL_KEY_ID;
    process.env.FORENSICS_ENCRYPTION_KEY_PRIOR_1 = CURRENT_KEY_B64;

    // Row claims key_id is "forensics-evil" but the ciphertext was encrypted with AAD="forensics-v1"
    mocks.row = makeRow(bundle, EVIL_KEY_ID);

    // Both AAD path (wrong AAD) and legacy path (tag covers AAD) must fail → throws
    await expect(decryptForensicsSnapshot("snap-tampered")).rejects.toThrow();
  });

  it("throws ForensicsKeyMissingError when encryption_key_id not in env", async () => {
    const bundle = buildBundle("{}", CURRENT_KEY_B64, CURRENT_KEY_ID, true);
    mocks.row = makeRow(bundle, "forensics-unknown-99");

    await expect(decryptForensicsSnapshot("snap-unknown-key")).rejects.toBeInstanceOf(
      ForensicsKeyMissingError,
    );
  });

  it("throws ForensicsSnapshotNotFoundError when row is null", async () => {
    mocks.row = null;

    await expect(decryptForensicsSnapshot("snap-missing")).rejects.toBeInstanceOf(
      ForensicsSnapshotNotFoundError,
    );
  });
});
