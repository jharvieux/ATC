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
