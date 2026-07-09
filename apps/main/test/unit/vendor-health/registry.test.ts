// §26.9 — Vendor health registry state transitions.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordVendorFailure,
  recordVendorSuccess,
  vendorHealthStatus,
  resolveVendorHealthStatus,
  snapshotVendorHealth,
  _resetVendorHealthForTests,
} from "@/lib/vendor-health/registry";

describe("vendorHealthStatus", () => {
  beforeEach(() => _resetVendorHealthForTests());

  it("starts healthy", () => {
    expect(vendorHealthStatus("anthropic")).toBe("healthy");
  });

  it("degrades after 3 consecutive failures", () => {
    recordVendorFailure("anthropic", "timeout");
    recordVendorFailure("anthropic", "timeout");
    expect(vendorHealthStatus("anthropic")).toBe("healthy");
    recordVendorFailure("anthropic", "timeout");
    expect(vendorHealthStatus("anthropic")).toBe("degraded");
  });

  it("escalates to down after 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) recordVendorFailure("anthropic", "5xx");
    expect(vendorHealthStatus("anthropic")).toBe("down");
  });

  it("returns to healthy on any success", () => {
    for (let i = 0; i < 6; i++) recordVendorFailure("openai", "x");
    expect(vendorHealthStatus("openai")).toBe("down");
    recordVendorSuccess("openai");
    expect(vendorHealthStatus("openai")).toBe("healthy");
  });

  it("tracks per-vendor independently", () => {
    for (let i = 0; i < 5; i++) recordVendorFailure("stripe", "x");
    expect(vendorHealthStatus("stripe")).toBe("down");
    expect(vendorHealthStatus("resend")).toBe("healthy");
  });

  it("#785: new vendors start healthy — inngest, upstash, rag, supabase_rag", () => {
    expect(vendorHealthStatus("inngest")).toBe("healthy");
    expect(vendorHealthStatus("upstash")).toBe("healthy");
    expect(vendorHealthStatus("rag")).toBe("healthy");
    expect(vendorHealthStatus("supabase_rag")).toBe("healthy");
  });

  it("#785: new vendors appear in snapshotVendorHealth()", () => {
    const snap = snapshotVendorHealth();
    expect(Object.keys(snap)).toEqual(
      expect.arrayContaining(["inngest", "upstash", "rag", "supabase_rag"]),
    );
  });
});

// ---------------------------------------------------------------------------
// #1646 — resolveVendorHealthStatus: cold-instance durable read-through.
// ---------------------------------------------------------------------------

function makeSelectDb(
  row: { status: string; consecutive_failures: number; last_checked_at: string | null; last_error: string | null; status_changed_at: string | null } | null,
  selectError: { message: string } | null = null,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: selectError });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from, _maybeSingle: maybeSingle };
}

describe("resolveVendorHealthStatus", () => {
  beforeEach(() => _resetVendorHealthForTests());

  it("cold instance (no in-process cache) sees a fleet-wide 'down' recorded by another instance", async () => {
    // This instance never called recordVendorFailure — the whole point of
    // #1646 is that the §26.9 chat fallback must still fire here.
    const db = makeSelectDb({ status: "down", consecutive_failures: 6, last_checked_at: "2026-07-09T00:00:00Z", last_error: "5xx", status_changed_at: "2026-07-08T23:00:00Z" });
    const status = await resolveVendorHealthStatus(db as never, "anthropic");
    expect(status).toBe("down");
  });

  it("warm in-process cache short-circuits the durable read (at most one DB round-trip per TTL)", async () => {
    recordVendorFailure("anthropic", "timeout"); // populates the in-process cache
    const db = makeSelectDb({ status: "down", consecutive_failures: 6, last_checked_at: null, last_error: null, status_changed_at: null });
    const status = await resolveVendorHealthStatus(db as never, "anthropic");
    expect(status).toBe("healthy"); // reflects the cached (1-failure) state, not the stale durable mock
    expect(db.from).not.toHaveBeenCalled();
  });

  it("fail-open on a durable read error: returns healthy and does not poison the cache for the next call", async () => {
    const db = makeSelectDb(null, { message: "connection refused" });
    const status = await resolveVendorHealthStatus(db as never, "openai");
    expect(status).toBe("healthy");
    // A cached error would freeze the fleet at "healthy" for a full TTL even
    // after the DB recovers — the retry must actually hit the DB again.
    await resolveVendorHealthStatus(db as never, "openai");
    expect(db._maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("caches a genuine 'no row yet' read (first probe hasn't run) so the second call skips the DB", async () => {
    const db = makeSelectDb(null);
    await resolveVendorHealthStatus(db as never, "resend");
    await resolveVendorHealthStatus(db as never, "resend");
    expect(db._maybeSingle).toHaveBeenCalledTimes(1);
  });
});
