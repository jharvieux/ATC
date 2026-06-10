// #902 / D-195 — TA daily cap. The property that matters: this cap is the
// only effective spend stop on the streaming path until #866 lands, so a
// count failure MUST deny (fail closed), and the boundary is >= cap.

import { describe, it, expect, vi } from "vitest";
import { enforceTaDailyLimit } from "@/lib/chat/ta-daily-limit";
import type { SupabaseClient } from "@supabase/supabase-js";

function dbStub(opts: {
  capSetting?: unknown;
  count?: number | null;
  countError?: { message: string } | null;
}): SupabaseClient {
  const messagesChain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte"]) messagesChain[m] = () => messagesChain;
  messagesChain.then = (resolve: (v: unknown) => void) =>
    resolve({ count: opts.count ?? null, error: opts.countError ?? null });

  const settingsChain: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) settingsChain[m] = () => settingsChain;
  settingsChain.maybeSingle = async () =>
    opts.capSetting === undefined
      ? { data: null, error: null }
      : { data: { value: opts.capSetting }, error: null };

  return {
    from: (t: string) => (t === "platform_settings" ? settingsChain : messagesChain),
  } as unknown as SupabaseClient;
}

const ARGS = { tenant_id: "tenant-1", user_id: "users-1" };

describe("enforceTaDailyLimit (#902)", () => {
  it("under cap → allowed with live count", async () => {
    const d = await enforceTaDailyLimit(dbStub({ count: 5 }), ARGS);
    expect(d).toEqual({ allowed: true, current_count: 5, cap: 200 });
  });

  it("at cap → denied (boundary is >=, not >)", async () => {
    const d = await enforceTaDailyLimit(dbStub({ count: 200 }), ARGS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("cap");
  });

  it("count error → DENIED, not allowed (fail closed — the cap is the only stop while #866 is open)", async () => {
    const d = await enforceTaDailyLimit(dbStub({ countError: { message: "boom" } }), ARGS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("count_unavailable");
  });

  it("null count (no error) → also denied", async () => {
    const d = await enforceTaDailyLimit(dbStub({ count: null }), ARGS);
    expect(d.allowed).toBe(false);
  });

  it("platform_settings override is honored", async () => {
    const d = await enforceTaDailyLimit(dbStub({ capSetting: 50, count: 50 }), ARGS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.cap).toBe(50);
  });

  it("garbage setting value falls back to the default cap", async () => {
    const d = await enforceTaDailyLimit(dbStub({ capSetting: "not-a-number", count: 5 }), ARGS);
    expect(d).toMatchObject({ allowed: true, cap: 200 });
  });
});
