// #2018 — attribution_rollup nightly refresh contract.
//
// The DB-side fix (20260722000029) swaps the expression unique index for a
// plain-column NULLS NOT DISTINCT one so REFRESH ... CONCURRENTLY can succeed.
// The cron itself keeps calling one SECURITY DEFINER RPC. These pin the
// app-side half of the contract: the EXACT RPC name (a rename desyncs the cron
// from the migration and re-breaks the nightly refresh), that a DB error is
// surfaced (so Inngest sees a failed run instead of a silent skip), and that
// the kill-switch / staging guards short-circuit before any DB work.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const insert = vi.fn(() => ({ then: (cb: (v: unknown) => unknown) => cb({ error: null }) }));
const from = vi.fn(() => ({ insert }));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ rpc, from }),
}));

import { runAttributionRollupRefresh } from "@/inngest/attribution-rollup-refresh";

const ENV_KEYS = ["BP36_ROLLUP_REFRESH_DISABLED", "STAGING_MODE"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  rpc.mockReset();
  insert.mockClear();
  from.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("runAttributionRollupRefresh", () => {
  it("invokes the refresh_attribution_rollup RPC and reports ok on success", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await runAttributionRollupRefresh();
    // The RPC name is the contract with the migration's SECURITY DEFINER fn.
    expect(rpc).toHaveBeenCalledWith("refresh_attribution_rollup");
    expect(result).toMatchObject({ ok: true });
  });

  it("throws on RPC failure (not a silent { error } return) so Inngest retries and the run reports failed", async () => {
    rpc.mockResolvedValue({ error: { message: "cannot refresh materialized view concurrently" } });
    await expect(runAttributionRollupRefresh()).rejects.toThrow(
      "refresh_attribution_rollup failed: cannot refresh materialized view concurrently",
    );
  });

  it("short-circuits on the BP36_ROLLUP_REFRESH_DISABLED kill switch without touching the DB", async () => {
    process.env.BP36_ROLLUP_REFRESH_DISABLED = "true";
    const result = await runAttributionRollupRefresh();
    expect(result).toEqual({ skipped: true, reason: "BP36_ROLLUP_REFRESH_DISABLED=true" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records a staging skip instead of refreshing when STAGING_MODE=true", async () => {
    process.env.STAGING_MODE = "true";
    const result = await runAttributionRollupRefresh();
    expect(result).toEqual({ skipped_for_staging: true });
    expect(from).toHaveBeenCalledWith("staging_cron_skips");
    expect(rpc).not.toHaveBeenCalled();
  });
});
