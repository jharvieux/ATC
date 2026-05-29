// #403 / §15.14 — finalizeTermination CAS + side-effect emit.
//
// WHY these cases matter:
//   - The CAS guard `.eq("status","suspended").select("id")` is what makes the
//     suspended→terminated transition idempotent. Zero rows means the
//     termination was RESCINDED within the 90-day window (§15.14.3) — a VALID
//     outcome that must return finalized:false and NOT emit, because the
//     nightly cron calls this on every due tenant and a throw would retry the
//     same rescinded tenant forever (this is the #394 zero-row CAS guard,
//     landed here per #403 fix-direction #2).
//   - tenant.terminated is emitted ONLY on a real transition, so the idempotent
//     side-effects consumer (domain unbind, host-credential deletion, RAG chunk
//     marking — §15.14.2) runs exactly once per actual termination.
//
// If anyone drops `.select("id")` from the CAS chain, the 0-row and 1-row cases
// become indistinguishable (data null for both) and the "no emit on rescind"
// test below flips to emitting — a cross-firing of irreversible side-effects.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("../../../src/inngest/client", () => ({
  inngest: {
    send: mocks.send,
    // tenant-on-terminated.ts registers two functions at module load; give
    // createFunction a no-op shape so the import doesn't throw.
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

import { finalizeTermination } from "../../../src/inngest/tenant-on-terminated";

type ScanResult = { data: Array<{ id: string }> | null; error: { message: string } | null };

function makeMockDb(result: ScanResult) {
  const select = () => Promise.resolve(result);
  const eqStatus = () => ({ select });
  const eqId = () => ({ eq: eqStatus });
  const update = () => ({ eq: eqId });
  return { from: () => ({ update }) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalizeTermination — CAS transition + tenant.terminated emit (#403)", () => {
  it("transitions on a 1-row match and emits tenant.terminated", async () => {
    const db = makeMockDb({ data: [{ id: "t-1" }], error: null });
    const result = await finalizeTermination(db, "t-1", "voluntary");
    expect(result).toEqual({ finalized: true });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "tenant.terminated",
      data: { tenant_id: "t-1", kind: "voluntary" },
    });
  });

  it("does NOT finalize or emit when zero rows match (rescinded within 90d, §15.14.3)", async () => {
    const db = makeMockDb({ data: [], error: null });
    const result = await finalizeTermination(db, "t-1", "involuntary_other");
    expect(result).toEqual({ finalized: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does NOT finalize or emit when data is null (Supabase zero-row variant)", async () => {
    const db = makeMockDb({ data: null, error: null });
    const result = await finalizeTermination(db, "t-1", "involuntary_content");
    expect(result).toEqual({ finalized: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("throws on a DB error and never emits (fail loud — cron will retry)", async () => {
    const db = makeMockDb({ data: null, error: { message: "connection reset" } });
    await expect(finalizeTermination(db, "t-1", "voluntary")).rejects.toThrow(/connection reset/);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects an out-of-enum kind before touching the DB or emitting", async () => {
    // Guards onTerminated's postTermStatus catch-all: a bad kind must not
    // silently route an involuntary_content termination to reviewed_retained.
    const db = makeMockDb({ data: [{ id: "t-1" }], error: null });
    await expect(
      finalizeTermination(db, "t-1", "involuntary_cuntent" as never),
    ).rejects.toThrow(/invalid termination kind/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
