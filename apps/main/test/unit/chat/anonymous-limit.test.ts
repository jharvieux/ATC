// §24.8 / F-sm-02 (#1377) — anonymous limit decision shape + concurrency.
//
// enforceAnonLimit is now consume-then-check: it increments each identifier's
// counter atomically (via the increment_anon_chat_counter RPC) and decides
// against the returned post-increment count. The fake Supabase client models
// that RPC with a synchronous shared counter — faithful to the real atomic
// INSERT … ON CONFLICT, so the concurrency test proves the wall holds.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { capsFromEnv, enforceAnonLimit } from "@/lib/chat/anonymous-limit";

// rpc("increment_anon_chat_counter", {p_identifier_type, p_identifier_value, ...})
// returns the post-increment count. `start(type)` seeds the pre-increment value
// per identifier type; each call atomically bumps and returns.
function makeRpcDb(start: (type: string) => number): SupabaseClient {
  const counts: Record<string, number> = {};
  return {
    rpc: async (_fn: string, p: { p_identifier_type: string; p_identifier_value: string }) => {
      const key = `${p.p_identifier_type}:${p.p_identifier_value}`;
      const next = (counts[key] ?? start(p.p_identifier_type)) + 1;
      counts[key] = next;
      return { data: next, error: null };
    },
  } as unknown as SupabaseClient;
}

const INPUT = { tenant_id: "t1", session_id: "s", ip: "1.1.1.1", fingerprint: "fp" };

describe("capsFromEnv", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });
  it("defaults to 5/15/10 normal", () => {
    expect(capsFromEnv(false)).toEqual({ session: 5, ip: 15, fingerprint: 10 });
  });
  it("defaults to 2/5/3 under abuse", () => {
    expect(capsFromEnv(true)).toEqual({ session: 2, ip: 5, fingerprint: 3 });
  });
});

describe("enforceAnonLimit", () => {
  it("allowed when all counts well below caps", async () => {
    const db = makeRpcDb(() => 0);
    const r = await enforceAnonLimit(db, INPUT);
    expect(r.allowed).toBe(true);
  });

  it("blocks on session cap first when session is hot", async () => {
    // session pre=5, cap=5 → post 6 > 5 → blocked; ip/fp fresh.
    const db = makeRpcDb((t) => (t === "session" ? 5 : 0));
    const r = await enforceAnonLimit(db, INPUT);
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("session");
  });

  it("blocks on IP when session is fresh but IP saturated", async () => {
    const db = makeRpcDb((t) => (t === "ip" ? 15 : 0));
    const r = await enforceAnonLimit(db, INPUT);
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("ip");
  });

  it("blocks on fingerprint when nothing else hit", async () => {
    const db = makeRpcDb((t) => (t === "fingerprint" ? 10 : 0));
    const r = await enforceAnonLimit(db, INPUT);
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("fingerprint");
  });

  it("under_abuse caps apply (2/5/3)", async () => {
    const db = makeRpcDb((t) => (t === "session" ? 2 : 0));
    const r = await enforceAnonLimit(db, { ...INPUT, under_abuse: true });
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("session");
  });

  it("no IP and no fingerprint → only session can block", async () => {
    const db = makeRpcDb(() => 0);
    const r = await enforceAnonLimit(db, { tenant_id: "t1", session_id: "s", ip: "", fingerprint: "" });
    expect(r.allowed).toBe(true);
  });

  it("fail-closed: RPC error → throws (not silently allowed)", async () => {
    const errorDb = {
      rpc: async () => ({ data: null, error: { message: "connection timeout" } }),
    } as unknown as SupabaseClient;
    await expect(enforceAnonLimit(errorDb, INPUT)).rejects.toThrow(/increment_anon_chat_counter failed/);
  });

  it("CONCURRENCY: K parallel at session cap-1 → exactly one allowed (wall holds)", async () => {
    // session pre=4 (cap-1, cap=5). 10 parallel requests; the atomic RPC hands
    // out distinct post-counts 5,6,7,… so only the one getting 5 is allowed.
    // ip/fp start fresh and stay under their caps, so session is the sole gate.
    const db = makeRpcDb((t) => (t === "session" ? 4 : 0));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enforceAnonLimit(db, INPUT)),
    );
    expect(results.filter((r) => r.allowed).length).toBe(1);
  });
});
