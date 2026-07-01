// Anonymous invite-token forum writes (thread create + message post) have no
// session/role gate, so a leaked link could otherwise drive unbounded paid
// Haiku moderation calls. Mirrors test/unit/chat/anonymous-limit.test.ts: the
// fake RPC models the atomic INSERT … ON CONFLICT increment.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceGuestForumWriteLimit } from "@/lib/forums/guest-write-limit";

function makeRpcDb(start: number): SupabaseClient {
  let count = start;
  return {
    rpc: async () => ({ data: ++count, error: null }),
  } as unknown as SupabaseClient;
}

describe("enforceGuestForumWriteLimit", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it("allowed when the post-increment count is under the default cap (20)", async () => {
    const db = makeRpcDb(0);
    await expect(enforceGuestForumWriteLimit(db, "inv-1", "t-1")).resolves.toBe(true);
  });

  it("blocked once the post-increment count exceeds the default cap", async () => {
    const db = makeRpcDb(20);
    await expect(enforceGuestForumWriteLimit(db, "inv-1", "t-1")).resolves.toBe(false);
  });

  it("respects FORUM_GUEST_WRITE_LIMIT_PER_HOUR override", async () => {
    process.env.FORUM_GUEST_WRITE_LIMIT_PER_HOUR = "2";
    const db = makeRpcDb(2);
    await expect(enforceGuestForumWriteLimit(db, "inv-1", "t-1")).resolves.toBe(false);
  });

  it("fail-closed: RPC error → throws (not silently allowed)", async () => {
    const errorDb = {
      rpc: async () => ({ data: null, error: { message: "connection timeout" } }),
    } as unknown as SupabaseClient;
    await expect(enforceGuestForumWriteLimit(errorDb, "inv-1", "t-1")).rejects.toThrow(
      /increment_forum_guest_write_counter failed/,
    );
  });

  it("CONCURRENCY: K parallel at cap-1 → exactly one allowed (wall holds)", async () => {
    const db = makeRpcDb(19);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enforceGuestForumWriteLimit(db, "inv-1", "t-1")),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });
});
