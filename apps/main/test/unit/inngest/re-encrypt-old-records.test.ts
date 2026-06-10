// #737 — re-encrypt-old-records: CAS row-count guard
//
// Verifies that when the UPDATE returns 0 rows (concurrent run already
// re-encrypted the record), reencryptedCount is NOT inflated. The bug
// would cause reencryptedCount to count rows the function didn't actually
// write, making the `remaining` metric and operator alerts misleading.

import { describe, it, expect, vi, beforeEach } from "vitest";

const PREV_KEY = Buffer.from("p".repeat(32)).toString("base64");
const PREV_KEY_ID = "v1";
const CURR_KEY = Buffer.from("c".repeat(32)).toString("base64");
const CURR_KEY_ID = "v2";

vi.mock("@/lib/env", () => ({
  env: () => ({
    APP_ENCRYPTION_KEY_CURRENT: CURR_KEY,
    APP_ENCRYPTION_KEY_ID_CURRENT: CURR_KEY_ID,
    APP_ENCRYPTION_KEY_PREVIOUS: PREV_KEY,
    APP_ENCRYPTION_KEY_ID_PREVIOUS: PREV_KEY_ID,
  }),
}));

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/crypto/credential-cipher", () => ({
  decryptCredential: vi.fn(() => ({ ok: true, value: "plaintext" })),
  encryptCredential: vi.fn(() => ({ ciphertext: "newcipher", key_id: CURR_KEY_ID })),
}));

// updateRows controls what .select("id") returns after the UPDATE.
const mocks = { updateRows: [] as { id: string }[] };

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "tenant_host_configs") {
        return {
          // SELECT to find records at old key
          select: () => ({
            filter: () => ({
              then(resolve: (v: { data: { id: string; credentials: { ciphertext: string; key_id: string } }[]; error: null }) => unknown) {
                return Promise.resolve(
                  resolve({
                    data: [{ id: "cfg-1", credentials: { ciphertext: "oldcipher", key_id: PREV_KEY_ID } }],
                    error: null,
                  }),
                );
              },
            }),
          }),
          // UPDATE chain for re-encryption
          update: () => ({
            eq: () => ({
              filter: () => ({
                select: () => ({
                  then(resolve: (v: { data: { id: string }[]; error: null }) => unknown) {
                    return Promise.resolve(resolve({ data: mocks.updateRows, error: null }));
                  },
                }),
              }),
            }),
          }),
        };
      }
      // platform_settings: no marker row exists
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: () => ({ then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })) }),
        delete: () => ({ eq: () => ({ then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })) }) }),
      };
    },
  }),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return {
    ...actual,
    safeAwait: vi.fn(async (p: Promise<unknown>) => p),
  };
});

vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler },
}));

beforeEach(() => {
  mocks.updateRows = [];
  vi.clearAllMocks();
});

import { reEncryptOldRecords } from "@/inngest/re-encrypt-old-records";

type ReencryptResult = { credentials_at_previous_key_count: number; reencryptedCount: number; failedCount: number };
const run = reEncryptOldRecords as unknown as () => Promise<ReencryptResult>;

describe("re-encrypt-old-records — CAS guard (#737)", () => {
  it("reencryptedCount is 1 when UPDATE matches the record", async () => {
    mocks.updateRows = [{ id: "cfg-1" }];
    const result = await run();
    expect(result.reencryptedCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it("#737: reencryptedCount is 0 when UPDATE returns 0 rows (concurrent run already re-encrypted)", async () => {
    mocks.updateRows = []; // concurrent run already moved the record to the new key
    const result = await run();
    // Pre-fix this would have incremented reencryptedCount to 1 despite no rows written.
    expect(result.reencryptedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });
});
