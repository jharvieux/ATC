// #805 / #807 — bulkFlipPendingStatus chunks the id list under PostgREST's URL
// limit, and is fail-loud: a failing chunk throws and aborts the rest of the
// list, leaving those rows un-flipped so the next flush re-submits them
// idempotently (rather than silently swallowing the error mid-list).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bulkFlipPendingStatus, STATUS_FLIP_CHUNK } from "@/lib/embeddings/batch/bulk-flip";

function mockDb(failIfChunkIncludes?: string) {
  const calls: string[][] = [];
  const db = {
    from(table: string) {
      if (table !== "pending_embedding") throw new Error(`unexpected table ${table}`);
      return {
        update(_payload: Record<string, unknown>) {
          return {
            in(_col: string, ids: string[]) {
              calls.push(ids);
              if (failIfChunkIncludes && ids.includes(failIfChunkIncludes)) {
                return Promise.resolve({ data: null, error: { message: "414 URI Too Long" } });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe("bulkFlipPendingStatus", () => {
  it("splits the id list into <= STATUS_FLIP_CHUNK updates", async () => {
    const { db, calls } = mockDb();
    await bulkFlipPendingStatus(db, ids(450), { status: "submitted" }, "ctx");
    expect(calls).toHaveLength(3); // 200, 200, 50
    expect(calls.every((c) => c.length <= STATUS_FLIP_CHUNK)).toBe(true);
    expect(calls.flat()).toHaveLength(450);
  });

  it("is fail-loud and aborts mid-list: a failing chunk throws and later chunks are NOT flipped (#807)", async () => {
    // Fail the 2nd chunk (contains p200). The 3rd chunk (p400+) must never run —
    // those rows stay pending and re-submit idempotently on the next flush.
    const { db, calls } = mockDb("p200");
    await expect(
      bulkFlipPendingStatus(db, ids(450), { status: "submitted" }, "ctx"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(200);
    expect(calls[1]).toContain("p200");
  });
});
