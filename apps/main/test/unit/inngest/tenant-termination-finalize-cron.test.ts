// #403 / §15.14 — nightly tenant-termination-finalize cron.
//
// WHY these cases matter:
//   - The `.not("termination_kind","is",null)` scan filter is load-bearing:
//     abuse-suspended tenants are also status='suspended' but have a null
//     termination_kind. Without the filter the cron would drive THEM to
//     terminated too — wrongful termination. The first test asserts the filter
//     is present in the scan chain.
//   - The cron must attempt EVERY due tenant before throwing, so one poison row
//     can't starve the rest (then fail loud so Inngest retries the failed ones).
//   - A scan error must throw (fail loud), not silently process zero rows.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  scanResult: { data: null as unknown, error: null as { message: string } | null },
  calls: [] as unknown[][],
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    send: vi.fn(),
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

vi.mock("@/inngest/tenant-on-terminated", () => ({
  finalizeTermination: mocks.finalize,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const builder: Record<string, (...a: unknown[]) => unknown> = {
      select: (...a: unknown[]) => {
        mocks.calls.push(["select", ...a]);
        return builder;
      },
      eq: (...a: unknown[]) => {
        mocks.calls.push(["eq", ...a]);
        return builder;
      },
      not: (...a: unknown[]) => {
        mocks.calls.push(["not", ...a]);
        return builder;
      },
      lte: (...a: unknown[]) => {
        mocks.calls.push(["lte", ...a]);
        return Promise.resolve(mocks.scanResult);
      },
    };
    return {
      from: (...a: unknown[]) => {
        mocks.calls.push(["from", ...a]);
        return builder;
      },
    };
  },
}));

import { tenantTerminationFinalize } from "@/inngest/tenant-termination-finalize";

// Extract the bare handler from the mocked createFunction wrapper.
const runCron = () =>
  (tenantTerminationFinalize as unknown as { handler: () => Promise<unknown> }).handler();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scanResult = { data: null, error: null };
  mocks.calls = [];
});

describe("tenantTerminationFinalize cron (#403)", () => {
  it("scans only suspended tenants with a non-null termination_kind past their window", async () => {
    mocks.scanResult = { data: [], error: null };
    await runCron();

    expect(mocks.calls).toContainEqual(["from", "tenants"]);
    expect(mocks.calls).toContainEqual(["eq", "status", "suspended"]);
    expect(mocks.calls).toContainEqual(["not", "termination_kind", "is", null]);
    // suspension_end_at <= now — assert the column + operator, not the timestamp.
    const lte = mocks.calls.find((c) => c[0] === "lte");
    expect(lte?.[1]).toBe("suspension_end_at");
  });

  it("finalizes every due tenant and counts only real transitions", async () => {
    mocks.scanResult = {
      data: [
        { id: "t-1", termination_kind: "voluntary" },
        { id: "t-2", termination_kind: "involuntary_content" },
      ],
      error: null,
    };
    // t-1 transitions; t-2 was rescinded within 90d (zero-row CAS → finalized:false).
    mocks.finalize
      .mockResolvedValueOnce({ finalized: true })
      .mockResolvedValueOnce({ finalized: false });

    const result = await runCron();

    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).toHaveBeenNthCalledWith(1, expect.anything(), "t-1", "voluntary");
    expect(mocks.finalize).toHaveBeenNthCalledWith(2, expect.anything(), "t-2", "involuntary_content");
    expect(result).toEqual({ scanned: 2, finalized: 1 });
  });

  it("throws on a scan error (fail loud — Inngest retries)", async () => {
    mocks.scanResult = { data: null, error: { message: "pool timeout" } };
    await expect(runCron()).rejects.toThrow(/scan failed.*pool timeout/);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("attempts ALL rows before throwing when one finalize fails", async () => {
    mocks.scanResult = {
      data: [
        { id: "t-1", termination_kind: "voluntary" },
        { id: "t-2", termination_kind: "voluntary" },
        { id: "t-3", termination_kind: "voluntary" },
      ],
      error: null,
    };
    mocks.finalize
      .mockResolvedValueOnce({ finalized: true })
      .mockRejectedValueOnce(new Error("t-2 boom"))
      .mockResolvedValueOnce({ finalized: true });

    await expect(runCron()).rejects.toThrow(/1\/3 failed/);
    // The poison row (t-2) must not stop t-3 from being attempted.
    expect(mocks.finalize).toHaveBeenCalledTimes(3);
  });
});
