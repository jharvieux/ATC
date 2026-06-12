// §24.8 — Anonymous limit decision shape.
//
// We exercise the public capsFromEnv() and the checkAnonLimit() decision
// against a fake Supabase client. The fake routes by table/identifier_value
// and returns canned counts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { capsFromEnv, checkAnonLimit } from "@/lib/chat/anonymous-limit";

function makeDbReturning(
  resolver: (args: { type: string; value: string }) => number,
): SupabaseClient {
  return {
    from() {
      let captured: { type?: string; value?: string } = {};
      const chain = {
        select() {
          return chain;
        },
        eq(col: string, val: unknown) {
          if (col === "identifier_type") captured.type = String(val);
          if (col === "identifier_value") captured.value = String(val);
          return chain;
        },
        gte() {
          return chain;
        },
        maybeSingle: () => {
          const count = resolver({ type: captured.type ?? "", value: captured.value ?? "" });
          captured = {};
          return Promise.resolve({ data: { current_count: count }, error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

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

describe("checkAnonLimit", () => {
  it("allowed when all counts well below caps", async () => {
    const db = makeDbReturning(() => 0);
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s",
      ip: "1.1.1.1",
      fingerprint: "fp",
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks on session cap first when session is hot", async () => {
    const db = makeDbReturning(({ type }) => (type === "session" ? 5 : 0));
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s",
      ip: "1.1.1.1",
      fingerprint: "fp",
    });
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("session");
  });

  it("blocks on IP when session is fresh but IP saturated", async () => {
    const db = makeDbReturning(({ type }) => (type === "ip" ? 15 : 0));
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s2",
      ip: "9.9.9.9",
      fingerprint: "fp",
    });
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("ip");
  });

  it("blocks on fingerprint when nothing else hit", async () => {
    const db = makeDbReturning(({ type }) => (type === "fingerprint" ? 10 : 0));
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s3",
      ip: "8.8.8.8",
      fingerprint: "fp",
    });
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("fingerprint");
  });

  it("under_abuse caps apply (2/5/3)", async () => {
    const db = makeDbReturning(({ type }) => (type === "session" ? 2 : 0));
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s",
      ip: "1.1.1.1",
      fingerprint: "fp",
      under_abuse: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.hit_identifier_type).toBe("session");
  });

  it("no IP and no fingerprint → only session can block", async () => {
    const db = makeDbReturning(() => 0);
    const r = await checkAnonLimit(db, {
      tenant_id: "t1",
      session_id: "s",
      ip: "",
      fingerprint: "",
    });
    expect(r.allowed).toBe(true);
  });

  it("fail-closed: DB error on counter read → throws (not silently allowed)", async () => {
    const errorDb: SupabaseClient = {
      from: (_t: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          maybeSingle: async () => ({ data: null, error: { message: "connection timeout" } }),
        };
        return chain as unknown as ReturnType<SupabaseClient["from"]>;
      },
    } as unknown as SupabaseClient;

    await expect(
      checkAnonLimit(errorDb, { tenant_id: "t1", session_id: "s", ip: "1.2.3.4", fingerprint: "fp" }),
    ).rejects.toThrow(/anonymous_chat_counters\.read failed/);
  });
});
