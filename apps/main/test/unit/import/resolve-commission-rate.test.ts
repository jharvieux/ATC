// BP34 §34.7.3 — Commission rate resolution tests.

import { describe, expect, it } from "vitest";
import { resolveCommissionRate } from "@/lib/import/resolve-commission-rate";

describe("resolveCommissionRate", () => {
  it("uses explicit doc-parsed rate when present", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: 0.12,
        commission_amount_cents: null,
        total_amount_cents: 100000,
        cruise_line: "Royal Caribbean",
      },
    });
    expect(r).toEqual({ rate: 0.12, source: "doc_parsed" });
  });

  it("derives implied rate from amount + fare", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: null,
        commission_amount_cents: 15000,
        total_amount_cents: 100000,
        cruise_line: "Royal Caribbean",
      },
    });
    expect(r).toMatchObject({ source: "doc_parsed", amount_cents: 15000 });
    expect(r!.rate).toBeCloseTo(0.15, 5);
  });

  it("falls through to host adapter when no doc rate", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: null,
        commission_amount_cents: null,
        total_amount_cents: 100000,
        cruise_line: "Royal Caribbean",
      },
      getAdapterRate: async () => 0.13,
    });
    expect(r).toEqual({ rate: 0.13, source: "host_adapter" });
  });

  it("returns null (review-required) when nothing resolves", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: null,
        commission_amount_cents: null,
        total_amount_cents: null,
        cruise_line: null,
      },
    });
    expect(r).toBeNull();
  });

  it("returns null when adapter throws", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: null,
        commission_amount_cents: null,
        total_amount_cents: 100000,
        cruise_line: "RC",
      },
      getAdapterRate: async () => {
        throw new Error("adapter down");
      },
    });
    expect(r).toBeNull();
  });

  it("ignores implausible implied rate (>50%)", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: null,
        commission_amount_cents: 80000,
        total_amount_cents: 100000, // 80% implied — bogus
        cruise_line: "RC",
      },
    });
    expect(r).toBeNull();
  });

  it("coerces percentage-as-integer (e.g. 12) to decimal", async () => {
    const r = await resolveCommissionRate({
      tenant_id: "t1",
      fields: {
        commission_rate: 12, // model returned 12 instead of 0.12
        commission_amount_cents: null,
        total_amount_cents: 100000,
        cruise_line: "RC",
      },
    });
    expect(r).toEqual({ rate: 0.12, source: "doc_parsed" });
  });
});
