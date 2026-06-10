// re-encrypt-old-records: CAS row-count guard (#737) + AAD-bind sweep (#935)
//
// #737: verifies that when the UPDATE returns 0 rows (concurrent run already
// re-encrypted the record), reencryptedCount is NOT inflated.
//
// #935: verifies that admin/bind_aad_credentials_started triggers a sweep of
// current-key rows and re-encrypts them (binding AAD), while NOT running on
// cron or reencrypt events.

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

// updateRows: what UPDATE .select("id") returns.
// prevKeySelectRows / currentKeySelectRows: what SELECT returns per key ID.
// aadSelectError: inject a SELECT error for the current-key sweep.
// aadUpdateError: inject an UPDATE error for the current-key sweep.
type CredRow = { id: string; credentials: { ciphertext: string; key_id: string } };
const mocks = {
  updateRows: [] as { id: string }[],
  prevKeySelectRows: [{ id: "cfg-1", credentials: { ciphertext: "oldcipher", key_id: PREV_KEY_ID } }] as CredRow[],
  currentKeySelectRows: [] as CredRow[],
  aadSelectError: null as { message: string } | null,
  aadUpdateError: null as { message: string } | null,
};

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "tenant_host_configs") {
        return {
          // SELECT to find records at a given key — returns rows based on the filter value.
          select: () => ({
            filter: (_col: string, _op: string, keyId: string) => ({
              then(resolve: (v: { data: CredRow[] | null; error: { message: string } | null }) => unknown) {
                if (keyId === CURR_KEY_ID && mocks.aadSelectError) {
                  return Promise.resolve(resolve({ data: null, error: mocks.aadSelectError }));
                }
                const rows = keyId === CURR_KEY_ID ? mocks.currentKeySelectRows : mocks.prevKeySelectRows;
                return Promise.resolve(resolve({ data: rows, error: null }));
              },
            }),
          }),
          // UPDATE chain for re-encryption
          update: () => ({
            eq: () => ({
              filter: () => ({
                select: () => ({
                  then(resolve: (v: { data: { id: string }[] | null; error: { message: string } | null }) => unknown) {
                    if (mocks.aadUpdateError) {
                      return Promise.resolve(resolve({ data: null, error: mocks.aadUpdateError }));
                    }
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
  mocks.prevKeySelectRows = [{ id: "cfg-1", credentials: { ciphertext: "oldcipher", key_id: PREV_KEY_ID } }];
  mocks.currentKeySelectRows = [];
  mocks.aadSelectError = null;
  mocks.aadUpdateError = null;
  vi.clearAllMocks();
});

import { reEncryptOldRecords } from "@/inngest/re-encrypt-old-records";

type ReencryptResult = { credentials_at_previous_key_count: number; reencryptedCount: number; failedCount: number };
type AadBindResult = { aad_bound_count: number; aad_bind_failed_count: number };
const run = reEncryptOldRecords as unknown as () => Promise<ReencryptResult>;
const runAadBind = reEncryptOldRecords as unknown as (ctx: { event: { name: string } }) => Promise<AadBindResult>;

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

describe("re-encrypt-old-records — AAD-bind sweep (#935)", () => {
  it("sweeps current-key rows and re-encrypts them when triggered by bind_aad event", async () => {
    mocks.currentKeySelectRows = [
      { id: "cfg-2", credentials: { ciphertext: "legacy-no-aad", key_id: CURR_KEY_ID } },
    ];
    mocks.updateRows = [{ id: "cfg-2" }];

    const result = await runAadBind({ event: { name: "admin/bind_aad_credentials_started" } });
    expect(result.aad_bound_count).toBe(1);
    expect(result.aad_bind_failed_count).toBe(0);
  });

  it("#935: bind_aad sweep does NOT run on cron/reencrypt — result has credentials_at_previous_key_count, not aad_bound_count", async () => {
    // run() with no ctx = cron/reencrypt path. Result shape differs from AAD-bind path.
    // This proves the event guard works: without the bind_aad event, the AAD sweep is skipped.
    mocks.updateRows = [{ id: "cfg-1" }];
    const result = await run() as unknown as Record<string, unknown>;
    expect(result.credentials_at_previous_key_count).toBeDefined();
    expect(result.aad_bound_count).toBeUndefined();
  });

  it("#935 fail-loud: SELECT error throws instead of silently returning empty result", async () => {
    mocks.aadSelectError = { message: "connection timeout" };
    await expect(
      runAadBind({ event: { name: "admin/bind_aad_credentials_started" } }),
    ).rejects.toThrow("bind-aad-sweep: failed to fetch rows");
  });

  it("#935 decrypt failure: aad_bind_failed_count increments, aad_bound_count stays 0", async () => {
    const { decryptCredential } = await import("@/lib/crypto/credential-cipher");
    vi.mocked(decryptCredential).mockReturnValueOnce({ ok: false, error: { code: "auth_tag_mismatch", key_id: CURR_KEY_ID } });
    mocks.currentKeySelectRows = [{ id: "cfg-2", credentials: { ciphertext: "corrupt", key_id: CURR_KEY_ID } }];

    const result = await runAadBind({ event: { name: "admin/bind_aad_credentials_started" } });
    expect(result.aad_bind_failed_count).toBe(1);
    expect(result.aad_bound_count).toBe(0);
  });

  it("#935 UPDATE error: aad_bind_failed_count increments, aad_bound_count stays 0", async () => {
    mocks.currentKeySelectRows = [{ id: "cfg-2", credentials: { ciphertext: "legacy-no-aad", key_id: CURR_KEY_ID } }];
    mocks.aadUpdateError = { message: "deadlock detected" };

    const result = await runAadBind({ event: { name: "admin/bind_aad_credentials_started" } });
    expect(result.aad_bind_failed_count).toBe(1);
    expect(result.aad_bound_count).toBe(0);
  });
});
