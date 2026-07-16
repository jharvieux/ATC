// §23.8 / #400 (D-091) — createNotification must surface a failed insert.
//
// Before the fix it discarded `{ error }` and returned null, so a dropped
// notification was indistinguishable from "nothing inserted" and silently
// lost. WHY this matters: the sole caller (the CCPA purge Inngest handler)
// notifies tenant admins about residual PII — a silently-dropped row is a
// compliance gap. The function now throws, which the Inngest handler turns
// into a retry. These tests fail if a regression reverts it to swallowing
// the error and returning null.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications/create";
import { SupabaseMutationError } from "@/lib/db/safe-mutation";

function makeDb(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const baseInput = {
  tenant_id: "t-1",
  user_id: "u-1",
  category: "system" as const,
  title: "Test notification",
};

describe("createNotification (#400)", () => {
  it("returns the inserted row id on success", async () => {
    const db = makeDb({ data: { id: "notif-1" }, error: null });
    const out = await createNotification({ db, ...baseInput });
    expect(out).toEqual({ id: "notif-1" });
  });

  it("throws SupabaseMutationError when the insert fails (not a silent null)", async () => {
    const db = makeDb({ data: null, error: { message: "insert blew up", code: "23503" } });
    await expect(createNotification({ db, ...baseInput })).rejects.toBeInstanceOf(SupabaseMutationError);
  });

  it("throws when the insert succeeds but returns no row (anomalous null)", async () => {
    const db = makeDb({ data: null, error: null });
    await expect(createNotification({ db, ...baseInput })).rejects.toBeInstanceOf(SupabaseMutationError);
  });
});

// #1954 (D-091 #24) — an Inngest retry of a partially-completed notification
// loop must not duplicate rows. WHY: the CCPA purge handler fans out one row
// per tenant admin; a retry re-runs the whole loop, so without a dedup_key the
// already-written rows are inserted again and admins get duplicate CCPA notices.
// A partial UNIQUE index on dedup_key makes the insert idempotent — a retry
// that hits 23505 returns the EXISTING row's id, never a second row.
describe("createNotification dedup_key idempotency (#1954)", () => {
  // Stateful fake: a Map models the UNIQUE(dedup_key) index. A repeat insert of
  // the same key returns Postgres 23505; createNotification must then resolve to
  // the stored id instead of throwing or writing a duplicate.
  function makeDedupDb() {
    const rows = new Map<string, { id: string; tenant_id: string }>();
    let seq = 0;
    const inserts: string[] = [];
    const db = {
      from: () => ({
        insert: (row: { dedup_key?: string; tenant_id: string }) => ({
          select: () => ({
            single: async () => {
              const key = row.dedup_key;
              if (key && rows.has(key)) {
                return { data: null, error: { code: "23505", message: "duplicate key" } };
              }
              const inserted = { id: `notif-${++seq}`, tenant_id: row.tenant_id };
              inserts.push(key ?? "<none>");
              if (key) rows.set(key, inserted);
              // Real insert().select("id") only projects the "id" column.
              return { data: { id: inserted.id }, error: null };
            },
          }),
        }),
        select: () => {
          const filters: Record<string, string> = {};
          const chain = {
            eq: (col: string, val: string) => {
              filters[col] = val;
              return chain;
            },
            single: async () => {
              const existing = rows.get(filters.dedup_key ?? "");
              return existing
                ? { data: existing, error: null }
                : { data: null, error: { code: "PGRST116", message: "no rows" } };
            },
          };
          return chain;
        },
      }),
    } as unknown as SupabaseClient;
    return { db, rows, inserts };
  }

  it("inserts exactly one row when the same dedup_key is written twice (retry is a no-op)", async () => {
    const { db, rows, inserts } = makeDedupDb();
    const input = { ...baseInput, dedup_key: "ccpa_purge:PU:u1" };

    const first = await createNotification({ db, ...input });
    const second = await createNotification({ db, ...input });

    // Same id both times → the retry resolved to the existing row, not a new one.
    expect(second).toEqual(first);
    // Exactly one physical insert landed for this key.
    expect(rows.size).toBe(1);
    expect(inserts).toEqual(["ccpa_purge:PU:u1"]);
  });

  it("distinct dedup_keys each produce their own row", async () => {
    const { db, rows } = makeDedupDb();
    await createNotification({ db, ...baseInput, dedup_key: "ccpa_purge:PU:u1" });
    await createNotification({ db, ...baseInput, dedup_key: "ccpa_purge:PU:u2" });
    expect(rows.size).toBe(2);
  });

  it("still surfaces a non-conflict insert error (does not swallow real failures)", async () => {
    const db = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { code: "23503", message: "fk violation" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      createNotification({ db, ...baseInput, dedup_key: "ccpa_purge:PU:u1" }),
    ).rejects.toBeInstanceOf(SupabaseMutationError);
  });

  // Guards the invariant a FUTURE non-globally-unique dedup_key would violate:
  // the lookup keys on dedup_key alone (matching the partial UNIQUE index), so
  // a collision across tenants must fail loud rather than silently hand back
  // another tenant's row id.
  it("throws instead of returning the id when the resolved row belongs to a different tenant", async () => {
    const db = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
          }),
        }),
        select: () => {
          const chain = {
            eq: () => chain,
            single: async () => ({
              data: { id: "notif-other-tenant", tenant_id: "t-2" },
              error: null,
            }),
          };
          return chain;
        },
      }),
    } as unknown as SupabaseClient;
    await expect(
      createNotification({ db, ...baseInput, dedup_key: "collided-key" }),
    ).rejects.toBeInstanceOf(SupabaseMutationError);
  });
});
