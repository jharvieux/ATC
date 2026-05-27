// D-091 P1 #24 — Payout CAS lock acquisition.
//
// Pre-fix: `.update().eq().eq("status", "available")` returned
// `{ data: null, error: null }` when zero rows matched; the handler
// proceeded to the Stripe transfer call, double-processing the payout.
//
// Post-fix: `.select("id")` chained after the update returns the rows
// that actually updated. Zero-length means lock already held → caller
// must skip the row.

import { describe, expect, it } from "vitest";
import { tryAcquirePayoutLock } from "../../../src/inngest/payouts-execute-transfer";

interface MockSupabase {
  // The chain methods the helper uses, scripted via the test setup.
  _setBehavior: (b: { data: Array<{ id: string }> | null; error: { message: string } | null }) => void;
  from: (table: string) => unknown;
}

function makeMockDb(): MockSupabase {
  let behavior: { data: Array<{ id: string }> | null; error: { message: string } | null } = {
    data: [],
    error: null,
  };
  const db = {
    _setBehavior(b: typeof behavior) {
      behavior = b;
    },
    from(_t: string) {
      return {
        update(_payload: unknown) {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async select(_cols: string) {
                      return { data: behavior.data, error: behavior.error };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return db as unknown as MockSupabase;
}

describe("tryAcquirePayoutLock — D-091 P1 #24 CAS row-count verification", () => {
  it("returns { acquired: true } when exactly 1 row updated", async () => {
    const db = makeMockDb();
    db._setBehavior({ data: [{ id: "payout-1" }], error: null });
    const result = await tryAcquirePayoutLock(db as never, "payout-1");
    expect(result).toEqual({ acquired: true });
  });

  it("returns { acquired: false, reason: 'already_locked' } on zero-row update", async () => {
    // THIS IS THE REGRESSION TEST. Pre-fix this case looked identical to
    // success — error was null, the handler proceeded to the Stripe call,
    // double-processing the payout.
    const db = makeMockDb();
    db._setBehavior({ data: [], error: null });
    const result = await tryAcquirePayoutLock(db as never, "payout-1");
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("already_locked");
  });

  it("returns { acquired: false, reason: 'already_locked' } on null data response", async () => {
    // Some Supabase versions return null instead of [] for a zero-row update.
    const db = makeMockDb();
    db._setBehavior({ data: null, error: null });
    const result = await tryAcquirePayoutLock(db as never, "payout-1");
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("already_locked");
  });

  it("returns { acquired: false, reason: 'db_error', error } on DB error", async () => {
    const db = makeMockDb();
    db._setBehavior({ data: null, error: { message: "connection reset" } });
    const result = await tryAcquirePayoutLock(db as never, "payout-1");
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("db_error");
    expect(result.error).toBe("connection reset");
  });

  // SAFETY ASSERTION: any future code that removes `.select("id")` from
  // the CAS chain (regressing to the original bug) would cause `data`
  // to be `null` for both the success case AND the zero-row case —
  // making them indistinguishable. The test above forces the
  // implementation to keep the `.select(...)` chain.
});
