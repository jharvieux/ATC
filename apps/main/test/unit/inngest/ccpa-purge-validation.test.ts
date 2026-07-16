// #742 — user-data-purge-after-grace must validate event payload with Zod so a
// crafted event (compromised Inngest signing key) cannot skip the 30-day grace period.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  sleepUntil: vi.fn(),
  purgeUser: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/privacy/purge-user-data", () => ({ purgeUserDataPerRetention: mocks.purgeUser }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ handler }),
  },
}));

import { userDataPurgeAfterGrace } from "@/inngest/user-data-purge-after-grace";

const fn = userDataPurgeAfterGrace as unknown as {
  handler: (ctx: { event: { data: unknown }; step: { sleepUntil: typeof mocks.sleepUntil } }) => Promise<unknown>;
};

function now() { return new Date().toISOString(); }
function daysAgo(n: number) { return new Date(Date.now() - n * 86_400_000).toISOString(); }
function daysAhead(n: number) { return new Date(Date.now() + n * 86_400_000).toISOString(); }

function chainable(leaf: object): object {
  const c: Record<string, unknown> = { ...leaf };
  // `range` is included so the #1958 recovery path (empty affected set →
  // recoverAffectedTenantIds → contacts.select().eq().range()) resolves cleanly
  // against this fake — the chained value is itself thenable/plain, so an
  // awaited `.range()` yields the leaf's `then` result (or the object, empty).
  for (const k of ["eq", "in", "order", "limit", "range"]) {
    c[k] = () => c;
  }
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The purge mock returns an empty affected_tenant_ids, which now triggers the
  // #1958 hash-recovery fallback; deriveCustomerHash requires PLATFORM_PEPPER.
  vi.stubEnv("PLATFORM_PEPPER", "test-pepper");
  const usersChain = chainable({
    maybeSingle: async () => ({ data: { deleted_at: daysAgo(30), status: "deleted" }, error: null }),
    then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })),
  });
  mocks.serviceClient.mockReturnValue({
    from: () => ({
      select: () => usersChain,
    }),
  });
  mocks.purgeUser.mockResolvedValue({ purge_outcome: "success", counts: {}, affected_tenant_ids: [], forensics_snapshot_id: null });
});

describe("userDataPurgeAfterGrace — Zod validation (#742)", () => {
  it("skips with invalid_payload when user_id is not a UUID", async () => {
    const result = await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "not-a-uuid",
          deleted_at: daysAgo(30),
          purge_at: daysAhead(1),
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });
    expect(result).toMatchObject({ skipped: true, reason: "invalid_payload" });
    expect(mocks.sleepUntil).not.toHaveBeenCalled();
  });

  it("skips with invalid_payload when purge_at is before deleted_at + 25 days", async () => {
    const deleted_at = daysAgo(30);
    // purge_at only 10 days after deleted_at — violates the 25-day minimum
    const purge_at = new Date(new Date(deleted_at).getTime() + 10 * 86_400_000).toISOString();
    const result = await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "00000000-0000-0000-0000-000000000002",
          deleted_at,
          purge_at,
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });
    expect(result).toMatchObject({ skipped: true, reason: "invalid_payload" });
  });

  it("proceeds when all fields are valid and purge_at is at least 25 days after deleted_at", async () => {
    const deleted_at = daysAgo(30);
    const purge_at = new Date(new Date(deleted_at).getTime() + 30 * 86_400_000).toISOString();
    const result = await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "00000000-0000-0000-0000-000000000002",
          deleted_at,
          purge_at,
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });
    expect(mocks.sleepUntil).toHaveBeenCalledWith("ccpa-grace-period", purge_at);
    // Handler continues to DB re-read; result depends on DB mock
    expect(result).not.toMatchObject({ reason: "invalid_payload" });
  });

  it("skips as stale when DB deleted_at differs from payload deleted_at — the real timing-bypass guard", async () => {
    // The Zod refine only validates the payload's own consistency; the load-bearing
    // check is the DB mismatch: even if an attacker forges a past purge_at that
    // passes the refine, the DB's deleted_at won't match and the job is skipped.
    const dbDeletedAt = daysAgo(30);
    const differentDeletedAt = daysAgo(35); // payload claims a different deletion time
    const purge_at = new Date(new Date(differentDeletedAt).getTime() + 30 * 86_400_000).toISOString();

    const usersChain = chainable({
      maybeSingle: async () => ({ data: { deleted_at: dbDeletedAt, status: "deleted" }, error: null }),
    });
    mocks.serviceClient.mockReturnValue({ from: () => ({ select: () => usersChain }) });

    const result = await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "00000000-0000-0000-0000-000000000002",
          deleted_at: differentDeletedAt,
          purge_at,
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });
    expect(result).toMatchObject({ skipped: true, reason: "stale" });
    expect(mocks.purgeUser).not.toHaveBeenCalled();
  });

  it("skips as undo_delete when the DB deleted_at is null (user undid the deletion)", async () => {
    // #1794: the null-deleted_at case is the crucial complement to the "stale"
    // test above — it's what happens after a SUCCESSFUL undo (deleted_at
    // cleared), not just a mismatched retry. Purging here would delete data
    // for a user who is no longer scheduled for deletion.
    const deleted_at = daysAgo(30);
    const purge_at = new Date(new Date(deleted_at).getTime() + 30 * 86_400_000).toISOString();

    const usersChain = chainable({
      maybeSingle: async () => ({ data: { deleted_at: null, status: "active" }, error: null }),
    });
    mocks.serviceClient.mockReturnValue({ from: () => ({ select: () => usersChain }) });

    const result = await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "00000000-0000-0000-0000-000000000002",
          deleted_at,
          purge_at,
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });
    expect(result).toMatchObject({ skipped: true, reason: "undo_delete" });
    expect(mocks.purgeUser).not.toHaveBeenCalled();
  });

  it("passes the DB-sourced deleted_at to purgeUserDataPerRetention, not the payload value", async () => {
    // Verifies the DB-sourced value is used — regression guard against reverting
    // to event payload, which is attacker-controllable.
    const dbDeletedAt = daysAgo(30);
    const purge_at = new Date(new Date(dbDeletedAt).getTime() + 30 * 86_400_000).toISOString();

    const usersChain = chainable({
      maybeSingle: async () => ({ data: { deleted_at: dbDeletedAt, status: "deleted" }, error: null }),
    });
    mocks.serviceClient.mockReturnValue({ from: () => ({ select: () => usersChain }) });

    await fn.handler({
      event: {
        data: {
          auth_user_id: "00000000-0000-0000-0000-000000000001",
          user_id: "00000000-0000-0000-0000-000000000002",
          deleted_at: dbDeletedAt,
          purge_at,
        },
      },
      step: { sleepUntil: mocks.sleepUntil },
    });

    expect(mocks.purgeUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grace_period_ended_at: dbDeletedAt }),
    );
  });
});
