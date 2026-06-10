// #904 — draft daily cap: fail-closed is the property that matters (the cap
// is the spend backstop; permitting on a failed count runs uncapped).

import { describe, it, expect } from "vitest";
import { enforceDraftReplyLimit } from "@/lib/draft/draft-reply-limit";
import type { SupabaseClient } from "@supabase/supabase-js";

function dbStub(opts: { capSetting?: unknown; count?: number | null; countError?: { message: string } }): SupabaseClient {
  const logChain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte"]) logChain[m] = () => logChain;
  logChain.then = (resolve: (v: unknown) => void) =>
    resolve({ count: opts.count ?? null, error: opts.countError ?? null });

  const settingsChain: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) settingsChain[m] = () => settingsChain;
  settingsChain.maybeSingle = async () =>
    opts.capSetting === undefined ? { data: null, error: null } : { data: { value: opts.capSetting }, error: null };

  return { from: (t: string) => (t === "platform_settings" ? settingsChain : logChain) } as unknown as SupabaseClient;
}

const ARGS = { tenant_id: "tenant-1", user_id: "users-1" };

describe("enforceDraftReplyLimit (#904)", () => {
  it("under cap → allowed", async () => {
    expect(await enforceDraftReplyLimit(dbStub({ count: 3 }), ARGS))
      .toEqual({ allowed: true, current_count: 3, cap: 100 });
  });

  it("at cap → denied (boundary is >=)", async () => {
    const d = await enforceDraftReplyLimit(dbStub({ count: 100 }), ARGS);
    expect(d.allowed).toBe(false);
  });

  it("count error → DENIED (fail closed)", async () => {
    const d = await enforceDraftReplyLimit(dbStub({ countError: { message: "boom" } }), ARGS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("count_unavailable");
  });

  it("platform_settings override honored; garbage falls back to default", async () => {
    expect((await enforceDraftReplyLimit(dbStub({ capSetting: 10, count: 10 }), ARGS)).allowed).toBe(false);
    expect((await enforceDraftReplyLimit(dbStub({ capSetting: "junk", count: 5 }), ARGS)))
      .toMatchObject({ allowed: true, cap: 100 });
  });
});
