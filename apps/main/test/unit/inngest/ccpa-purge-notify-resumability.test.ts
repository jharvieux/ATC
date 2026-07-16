// #1958 — user-data-purge-after-grace: a notification that fails after a
// successful purge must eventually be delivered on retry, exactly once.
//
// WHY this matters (and why it's distinct from #1954): the notify loop throws
// to trigger an Inngest retry, but the purge sets users.status='purged' as its
// last step, and the handler used to short-circuit on that status BEFORE the
// notify loop. So the retry re-read the user, saw 'purged', and returned early
// — the notification was NEVER re-attempted. Affected tenant admins silently
// never received their CCPA notice.
//
// These tests model the real Inngest retry (a second invocation of the handler
// against the same mutated DB state) and assert the acceptance criterion:
// purge succeeds, one notification fails, retry → the recipient gets EXACTLY
// one notification (not zero — the bug — and not two — a #1954 regression).
// The REAL createNotification runs against a fake DB that enforces the
// UNIQUE(dedup_key) index, so idempotency and resumability are proven together.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  sleepUntil: vi.fn(),
  purgeUser: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/privacy/purge-user-data", () => ({ purgeUserDataPerRetention: mocks.purgeUser }));
// createNotification is NOT mocked — we exercise the real dedup path.
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ handler }),
  },
}));

import { userDataPurgeAfterGrace } from "@/inngest/user-data-purge-after-grace";

const fn = userDataPurgeAfterGrace as unknown as {
  handler: (ctx: {
    event: { data: unknown };
    step: { sleepUntil: typeof mocks.sleepUntil };
  }) => Promise<unknown>;
};

const DELETED_AT = new Date(Date.now() - 30 * 86_400_000).toISOString();
const PURGE_AT = new Date(new Date(DELETED_AT).getTime() + 30 * 86_400_000).toISOString();
const USER_ID = "00000000-0000-0000-0000-000000000002";
const TENANT_A = "tenant-a";

type State = {
  usersRow: { deleted_at: string | null; status: string };
  activeAdmins: Record<string, Array<{ id: string }>>;
  contactRows: Array<{ tenant_id: string }>;
  notifications: Map<string, { id: string }>;
  plainInserts: Array<{ id: string }>;
  failInsertOnce: Set<string>;
};

// Fake DB: models the users re-read, the active-admin paginated scan, the
// anonymized-hash contact recovery, and a UNIQUE(dedup_key) notifications table.
function makeDb(state: State) {
  let seq = 0;
  return {
    from(table: string) {
      if (table === "users") {
        return {
          select() {
            const filters: Record<string, string> = {};
            const builder: Record<string, unknown> = {
              eq(col: string, val: string) {
                filters[col] = val;
                return builder;
              },
              async maybeSingle() {
                return { data: state.usersRow, error: null };
              },
              range(a: number, b: number) {
                const admins = state.activeAdmins[filters.tenant_id ?? ""] ?? [];
                return Promise.resolve({ data: admins.slice(a, b + 1), error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "contacts") {
        return {
          select() {
            const builder: Record<string, unknown> = {
              eq() {
                return builder;
              },
              range(a: number, b: number) {
                return Promise.resolve({ data: state.contactRows.slice(a, b + 1), error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "notifications") {
        return {
          insert(row: { dedup_key?: string }) {
            return {
              select() {
                return {
                  async single() {
                    const key = row.dedup_key;
                    if (key && state.notifications.has(key)) {
                      return { data: null, error: { code: "23505", message: "duplicate key" } };
                    }
                    if (key && state.failInsertOnce.has(key)) {
                      state.failInsertOnce.delete(key);
                      return { data: null, error: { code: "08006", message: "connection reset" } };
                    }
                    const inserted = { id: `notif-${++seq}` };
                    if (key) state.notifications.set(key, inserted);
                    else state.plainInserts.push(inserted);
                    return { data: inserted, error: null };
                  },
                };
              },
            };
          },
          select() {
            const filters: Record<string, string> = {};
            const builder: Record<string, unknown> = {
              eq(col: string, val: string) {
                filters[col] = val;
                return builder;
              },
              async single() {
                const existing = state.notifications.get(filters.dedup_key ?? "");
                return existing
                  ? { data: existing, error: null }
                  : { data: null, error: { code: "PGRST116", message: "no rows" } };
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function invoke(step = { sleepUntil: mocks.sleepUntil }) {
  return fn.handler({
    event: {
      data: {
        auth_user_id: "00000000-0000-0000-0000-000000000001",
        user_id: USER_ID,
        deleted_at: DELETED_AT,
        purge_at: PURGE_AT,
      },
    },
    step,
  });
}

let state: State;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PLATFORM_PEPPER", "test-pepper"); // real deriveCustomerHash needs it
  state = {
    usersRow: { deleted_at: DELETED_AT, status: "deleted" },
    activeAdmins: { [TENANT_A]: [{ id: "u1" }, { id: "u2" }] },
    contactRows: [{ tenant_id: TENANT_A }],
    notifications: new Map(),
    plainInserts: [],
    failInsertOnce: new Set(),
  };
  mocks.serviceClient.mockReturnValue(makeDb(state));

  // A successful purge flips status='purged' (as the real purge does at its
  // last step) and reports the affected tenant.
  mocks.purgeUser.mockImplementation(async () => {
    state.usersRow.status = "purged";
    return {
      purge_outcome: "success",
      counts: {},
      forensics_snapshot_id: null,
      affected_tenant_ids: [TENANT_A],
    };
  });
});

describe("userDataPurgeAfterGrace — notification resumability (#1958)", () => {
  it("delivers a failed notification on retry — exactly one row per recipient, not zero, not two", async () => {
    // u2's first insert fails transiently; u1 succeeds. The loop throws to retry.
    state.failInsertOnce.add(`ccpa_purge:${USER_ID}:u2`);

    // Run 1: purge succeeds, u1 notified, u2 fails → fail-loud throw.
    await expect(invoke()).rejects.toThrow(/notification\(s\) failed/);
    expect(state.notifications.size).toBe(1); // only u1 so far
    expect(state.usersRow.status).toBe("purged");

    // Run 2 = Inngest retry. status is now 'purged'; the OLD code returned here.
    const result = await invoke();

    // Purge did NOT re-run (its idempotency guard held)…
    expect(mocks.purgeUser).toHaveBeenCalledTimes(1);
    // …but notification delivery DID resume via hash recovery.
    expect(result).toMatchObject({ ok: true, already_purged: true, affected_tenant_ids: [TENANT_A] });

    // Exactly one notification per recipient: u2 now delivered, u1 not duplicated.
    expect(state.notifications.size).toBe(2);
    expect([...state.notifications.keys()].sort()).toEqual([
      `ccpa_purge:${USER_ID}:u1`,
      `ccpa_purge:${USER_ID}:u2`,
    ]);
    expect(state.plainInserts).toHaveLength(0);
  });

  it("recovers the notify audience when a mid-purge retry re-runs an already-anonymized purge (#1958 audit)", async () => {
    // First attempt: purgeUserDataPerRetention is non-transactional. Step 5
    // anonymized the contacts (stamping anonymized_customer_hash, nulling
    // user_id) but the run threw before Step 8 flipped status='purged', so it
    // reports an error and status stays 'deleted'.
    // Retry: status is still 'deleted' → the fresh-purge branch re-runs the
    // purge, but Step 5 now matches zero rows (contacts already anonymized), so
    // the purge succeeds with an EMPTY affected_tenant_ids. Without the
    // hash-recovery fallback the handler would notify nobody.
    let purgeCall = 0;
    mocks.purgeUser.mockImplementation(async () => {
      purgeCall++;
      if (purgeCall === 1) {
        return { purge_outcome: "error", error_detail: "threw after anonymize", counts: {} };
      }
      state.usersRow.status = "purged";
      return {
        purge_outcome: "success",
        counts: {},
        forensics_snapshot_id: null,
        affected_tenant_ids: [],
      };
    });

    // Run 1: purge fails after anonymizing → handler returns ok:false, no notifies.
    const first = await invoke();
    expect(first).toMatchObject({ ok: false });
    expect(state.notifications.size).toBe(0);
    expect(state.usersRow.status).toBe("deleted");

    // Run 2 = Inngest retry. Fresh-purge branch, empty affected set → the
    // fallback recovers [TENANT_A] from the anonymized_customer_hash.
    const second = await invoke();
    expect(second).toMatchObject({ ok: true, already_purged: false, affected_tenant_ids: [TENANT_A] });
    expect(mocks.purgeUser).toHaveBeenCalledTimes(2);

    // The original audience (TENANT_A admins u1, u2) is notified exactly once.
    expect(state.notifications.size).toBe(2);
    expect([...state.notifications.keys()].sort()).toEqual([
      `ccpa_purge:${USER_ID}:u1`,
      `ccpa_purge:${USER_ID}:u2`,
    ]);
    expect(state.plainInserts).toHaveLength(0);
  });

  it("a clean retry after full success re-runs the idempotent loop without duplicating", async () => {
    // Run 1: everything succeeds.
    const first = await invoke();
    expect(first).toMatchObject({ ok: true, already_purged: false });
    expect(state.notifications.size).toBe(2);

    // Run 2 (e.g. duplicate event delivery): status='purged' → recovery →
    // every insert hits 23505 → no new rows.
    const second = await invoke();
    expect(second).toMatchObject({ ok: true, already_purged: true });
    expect(state.notifications.size).toBe(2);
    expect(mocks.purgeUser).toHaveBeenCalledTimes(1);
  });
});
