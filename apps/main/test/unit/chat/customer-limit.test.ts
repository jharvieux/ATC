// §24.9 — enforceCustomerLimit fail-closed behaviour.
//
// Pins that a DB error on the counter read (or the recount-from-messages
// path) throws rather than seeding the counter at 0 and granting the user
// the full rate-limit quota.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceCustomerLimit } from "@/lib/chat/customer-limit";

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";

// resolveCustomerChatCaps RPC always succeeds with conservative defaults.
function makeDb(opts: {
  counterData?: Record<string, unknown> | null;
  counterError?: { message: string } | null;
  recountError?: { message: string } | null;
}): SupabaseClient {
  return {
    rpc: (_fn: string) => ({
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    }),
    from: (table: string) => {
      if (table === "customer_chat_counters") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.counterData !== undefined ? opts.counterData : null,
                  error: opts.counterError ?? null,
                }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                then: (r: (v: { data: null; error: null }) => unknown) =>
                  Promise.resolve({ data: null, error: null }).then(r),
              }),
            }),
          }),
          insert: () => ({
            then: (r: (v: { data: null; error: null }) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(r),
          }),
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      if (table === "messages") {
        // recountFromMessages path
        const msgChain = {
          select: () => msgChain,
          eq: () => msgChain,
          gte: () => msgChain,
          then: (r: (v: { data: null; error: { message: string } | null }) => unknown) =>
            Promise.resolve({
              data: null,
              error: opts.recountError ?? null,
            }).then(r),
        };
        return msgChain as unknown as ReturnType<SupabaseClient["from"]>;
      }
      throw new Error("unexpected table: " + table);
    },
  } as unknown as SupabaseClient;
}

describe("enforceCustomerLimit — fail-closed DB error paths", () => {
  it("throws when the counter SELECT errors (not silently seeds at 0)", async () => {
    const db = makeDb({ counterError: { message: "PG timeout" } });
    await expect(enforceCustomerLimit(db, { user_id: USER_ID, tenant_id: TENANT_ID })).rejects.toThrow(
      /customer_chat_counters\.read failed/,
    );
  });

  it("throws when recountFromMessages SELECT errors (counter row absent, recount fails)", async () => {
    // counter is absent (no error, data: null) → triggers recountFromMessages → that errors
    const db = makeDb({ counterData: null, counterError: null, recountError: { message: "messages read failed" } });
    await expect(enforceCustomerLimit(db, { user_id: USER_ID, tenant_id: TENANT_ID })).rejects.toThrow(
      /customer_chat\.recount_from_messages failed/,
    );
  });
});
